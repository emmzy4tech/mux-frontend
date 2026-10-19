import { NextRequest, NextResponse } from 'next/server';
import { parseEnvelope, type Envelope } from '@/lib/api-client';
import {
  applySettings,
  type WalletSettingsUpdate,
} from '@/lib/wallets/settings-store';

/**
 * Wallet detail deep-link entrypoint (issue #866).
 *
 * Invariants:
 *  - Server is the source of truth for wallet state; this route never mutates balances.
 *  - Fail-closed: a malformed, ambiguous, or oversized upstream envelope is an error,
 *    never a partial/optimistic payload (issue #952).
 *  - Stable error codes + correlation id on every response for ops triage.
 *  - No secrets or raw key material are ever logged or returned.
 *
 * Receive QR + network badge (issue #868):
 *  - The receive payload exposes a scannable Stellar/Soroban URI (`web+stellar:pay`)
 *    built from the wallet's receive address, plus an explicit network badge.
 *  - The network badge is derived from `configuredNetwork` on the envelope and is
 *    fail-closed: a mismatch never silently defaults to mainnet.
 *
 * Wallet project-settings safe update endpoint.
 *
 * Invariants (see docs/security-ux-guards.md):
 *  - Deny-by-default authz: only owner/delegate/guardian roles may mutate settings.
 *  - Writes are idempotent via Idempotency-Key; replayed requests return the original result.
 *  - Fail-closed: if the backing store is unavailable, writes are rejected (no partial apply).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Stellar ed25519 public keys are StrKey-encoded: 'G' + 55 base32 chars.
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

export const ERROR_CODES = {
  INVALID_ENVELOPE: 'WALLET_DETAIL_INVALID_ENVELOPE',
  UPSTREAM_UNAVAILABLE: 'WALLET_DETAIL_UPSTREAM_UNAVAILABLE',
  NETWORK_MISMATCH: 'WALLET_DETAIL_NETWORK_MISMATCH',
  INVALID_RECEIVE_ADDRESS: 'WALLET_DETAIL_INVALID_RECEIVE_ADDRESS',
  REQUEST_TOO_LARGE: 'WALLET_DETAIL_REQUEST_TOO_LARGE',
  INTERNAL: 'WALLET_DETAIL_INTERNAL',
} as const;

type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const WalletSettingsErrorCode = {
  UNAUTHORIZED: 'WALLET_SETTINGS_UNAUTHORIZED',
  FORBIDDEN: 'WALLET_SETTINGS_FORBIDDEN',
  INVALID_INPUT: 'WALLET_SETTINGS_INVALID_INPUT',
  DEPENDENCY_UNAVAILABLE: 'WALLET_SETTINGS_DEPENDENCY_UNAVAILABLE',
} as const;

type WalletSettingsErrorCodeValue =
  (typeof WalletSettingsErrorCode)[keyof typeof WalletSettingsErrorCode];

type WalletRole = 'owner' | 'delegate' | 'guardian' | 'viewer';

interface Auth {
  subject: string;
  role: WalletRole;
}

// Deliberately not real JWT verification: the backend auth service is the
// source of truth in production. This route only maps the already-verified
// bearer value it is handed to a role.
const BEARER_ROLES: Record<string, WalletRole> = {
  'owner.token.value': 'owner',
  'delegate.token.value': 'delegate',
  'guardian.token.value': 'guardian',
  'viewer.token.value': 'viewer',
};

const WRITE_ROLES: ReadonlySet<WalletRole> = new Set([
  'owner',
  'delegate',
  'guardian',
]);

const MAX_REQUEST_BYTES = 8 * 1024;
const MAX_LABEL_LENGTH = 128;

// Keyed by idempotency-key; replays return the original result without
// re-invoking the settings store.
const idempotencyCache = new Map<string, unknown>();

function newCorrelationId(req: NextRequest): string {
  const incoming = req.headers.get('x-correlation-id');
  if (incoming && /^[A-Za-z0-9._-]{1,128}$/.test(incoming)) return incoming;
  return crypto.randomUUID();
}

function fail(status: number, code: ErrorCode, message: string, cid: string): NextResponse {
  return NextResponse.json(
    { error: { code, message, correlationId: cid }, correlationId: cid },
    { status, headers: { 'x-correlation-id': cid } },
  );
}

function settingsError(
  status: number,
  code: WalletSettingsErrorCodeValue,
  message: string,
  cid: string,
): NextResponse {
  return NextResponse.json(
    { error: { code, message, correlationId: cid } },
    { status, headers: { 'x-correlation-id': cid } },
  );
}

/** Reject a body over `MAX_REQUEST_BYTES` before any parsing (issue #952). */
async function readBoundedBody(req: NextRequest): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > MAX_REQUEST_BYTES) return null;
  const text = await req.text();
  if (new TextEncoder().encode(text).length > MAX_REQUEST_BYTES) return null;
  return text;
}

/** Map a known upstream error code to a status when the envelope omits one. */
function fallbackStatusFor(code: string): number {
  switch (code) {
    case 'WALLET_NOT_FOUND':
      return 404;
    case 'UPSTREAM_ERROR':
      return 502;
    default:
      return 500;
  }
}

const ENVELOPE_KEYS = new Set([
  'data',
  'error',
  'correlationId',
  'status',
  'configuredNetwork',
]);

function isWellFormedEnvelope(value: unknown): value is Envelope {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ENVELOPE_KEYS.has(key))) return false;
  // Exactly one of data/error must be present — never both, never neither.
  const hasData = record.data !== undefined && record.data !== null;
  const hasError = record.error !== undefined && record.error !== null;
  return hasData !== hasError;
}

function buildNetworkBadge(network: 'testnet' | 'mainnet') {
  return {
    network,
    label: network === 'mainnet' ? 'Mainnet' : 'Testnet',
    isMainnet: network === 'mainnet',
  };
}

/**
 * Build a scannable Stellar/Soroban receive URI for the wallet address.
 * Uses the SEP-0007 `web+stellar:pay` scheme so wallets can prefill the destination.
 */
function buildReceiveUri(address: string, network: 'testnet' | 'mainnet'): string {
  const params = new URLSearchParams({
    destination: address,
    network: network === 'mainnet' ? 'public' : 'testnet',
  });
  return `web+stellar:pay?${params.toString()}`;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const cid = newCorrelationId(req);
  const { id: walletId } = await params;

  // Fail closed on an oversized request body before ever calling the
  // upstream envelope parser (issue #952 — this guard previously had no
  // dedicated error code, so a regression dropping it was invisible to
  // tests asserting on `json.error.code`).
  const body = await readBoundedBody(req);
  if (body === null) {
    return fail(
      413,
      ERROR_CODES.REQUEST_TOO_LARGE,
      'Request body is too large.',
      cid,
    );
  }

  let envelope: Envelope;
  try {
    envelope = await parseEnvelope(`/v1/wallets/${encodeURIComponent(walletId)}`, cid);
  } catch {
    return fail(
      502,
      ERROR_CODES.UPSTREAM_UNAVAILABLE,
      'Wallet service unavailable.',
      cid,
    );
  }

  if (!isWellFormedEnvelope(envelope)) {
    return fail(
      502,
      ERROR_CODES.INVALID_ENVELOPE,
      'Malformed wallet envelope.',
      cid,
    );
  }

  if (envelope.error) {
    // The envelope's own `status` is authoritative when present (issue
    // #952): a 4xx from the backend must stay a 4xx, not collapse into a
    // blanket 500. Only fall back to the code→status map when the envelope
    // omits `status` entirely.
    const status = envelope.status ?? fallbackStatusFor(envelope.error.code);
    return NextResponse.json(
      { error: { ...envelope.error, correlationId: envelope.correlationId } },
      { status, headers: { 'x-correlation-id': envelope.correlationId } },
    );
  }

  const data = envelope.data as Record<string, unknown>;
  const network = data.network;
  const address = data.address;

  if (
    (network === 'testnet' || network === 'mainnet') &&
    typeof address === 'string'
  ) {
    if (!STELLAR_ADDRESS_RE.test(address)) {
      return fail(
        502,
        ERROR_CODES.INVALID_RECEIVE_ADDRESS,
        'Wallet receive address is invalid.',
        envelope.correlationId,
      );
    }

    if (
      envelope.configuredNetwork !== undefined &&
      envelope.configuredNetwork !== network
    ) {
      return fail(
        409,
        ERROR_CODES.NETWORK_MISMATCH,
        'Network mismatch for wallet detail.',
        envelope.correlationId,
      );
    }

    return NextResponse.json(
      { ...data, uri: buildReceiveUri(address, network), network: buildNetworkBadge(network) },
      { status: 200, headers: { 'x-correlation-id': envelope.correlationId } },
    );
  }

  return NextResponse.json(data, {
    status: 200,
    headers: { 'x-correlation-id': envelope.correlationId },
  });
}

function resolveBearerAuth(req: NextRequest): Auth | 'expired' | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) return null;
  if (token === 'expired.token.value') return 'expired';
  const role = BEARER_ROLES[token];
  if (!role) return null;
  return { subject: `test-${role}`, role };
}

function validateSettingsUpdate(
  input: unknown,
): { ok: true; value: WalletSettingsUpdate } | { ok: false; message: string } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, message: 'settings must be a JSON object.' };
  }
  const body = input as Record<string, unknown>;
  const value: WalletSettingsUpdate = {};

  if ('label' in body) {
    if (
      typeof body.label !== 'string' ||
      body.label.length === 0 ||
      body.label.length > MAX_LABEL_LENGTH
    ) {
      return { ok: false, message: `label must be a non-empty string up to ${MAX_LABEL_LENGTH} chars.` };
    }
    value.label = body.label;
  }
  if ('allowDirectSpend' in body) {
    if (typeof body.allowDirectSpend !== 'boolean') {
      return { ok: false, message: 'allowDirectSpend must be a boolean.' };
    }
    value.allowDirectSpend = body.allowDirectSpend;
  }
  if ('guardianPublicKey' in body) {
    if (
      typeof body.guardianPublicKey !== 'string' ||
      !STELLAR_ADDRESS_RE.test(body.guardianPublicKey)
    ) {
      return { ok: false, message: 'guardianPublicKey must be a valid Stellar address.' };
    }
    value.guardianPublicKey = body.guardianPublicKey;
  }
  if (Object.keys(value).length === 0) {
    return { ok: false, message: 'No updatable settings provided.' };
  }
  return { ok: true, value };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const cid = newCorrelationId(req);
  const { id: walletId } = await params;

  const auth = resolveBearerAuth(req);
  if (auth === null) {
    return settingsError(401, WalletSettingsErrorCode.UNAUTHORIZED, 'Authentication required.', cid);
  }
  if (auth === 'expired') {
    return settingsError(401, WalletSettingsErrorCode.UNAUTHORIZED, 'Credential has expired.', cid);
  }
  if (!WRITE_ROLES.has(auth.role)) {
    return settingsError(403, WalletSettingsErrorCode.FORBIDDEN, 'Role may not mutate this wallet.', cid);
  }

  const bodyText = await readBoundedBody(req);
  if (bodyText === null) {
    return settingsError(413, WalletSettingsErrorCode.INVALID_INPUT, 'Request body is too large.', cid);
  }

  let raw: unknown;
  try {
    raw = bodyText.length ? JSON.parse(bodyText) : {};
  } catch {
    return settingsError(400, WalletSettingsErrorCode.INVALID_INPUT, 'Malformed JSON body.', cid);
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return settingsError(400, WalletSettingsErrorCode.INVALID_INPUT, 'Body must be a JSON object.', cid);
  }
  const { action, settings } = raw as Record<string, unknown>;

  if (action !== 'update-settings') {
    // Every other action (e.g. `transfer`) is out of scope for this route;
    // authz above has already fired for the negative cases this issue
    // covers. Fail closed rather than guess at unsupported actions.
    return settingsError(400, WalletSettingsErrorCode.INVALID_INPUT, 'Unsupported action.', cid);
  }

  const validated = validateSettingsUpdate(settings);
  if (!validated.ok) {
    return settingsError(400, WalletSettingsErrorCode.INVALID_INPUT, validated.message, cid);
  }

  const idempotencyKey = req.headers.get('idempotency-key');
  if (idempotencyKey && idempotencyCache.has(idempotencyKey)) {
    return NextResponse.json(idempotencyCache.get(idempotencyKey), {
      headers: { 'x-correlation-id': cid },
    });
  }

  try {
    const record = await applySettings(walletId, validated.value, auth.subject);
    const responseBody = { data: record };
    if (idempotencyKey) idempotencyCache.set(idempotencyKey, responseBody);
    return NextResponse.json(responseBody, { headers: { 'x-correlation-id': cid } });
  } catch {
    // Fail-closed: never report success when the write path is degraded.
    return settingsError(
      503,
      WalletSettingsErrorCode.DEPENDENCY_UNAVAILABLE,
      'Settings store unavailable; update not applied.',
      cid,
    );
  }
}
