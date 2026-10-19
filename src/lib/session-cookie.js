/**
 * Session cookie helpers shared by the login (set) and logout (clear) code
 * paths (#766).
 *
 * `SESSION_COOKIE_NAME` and `SESSION_COOKIE_ATTRIBUTES` are the single
 * source of truth for the cookie's name and shape: both `buildSessionCookie`
 * and `buildClearSessionCookie` read from them rather than hardcoding their
 * own copies, so parity holds across environments and a logout can never
 * fail to clear a cookie set at login with different attributes.
 *
 * `secure` defaults to `true` (fail closed) when omitted: a caller must
 * explicitly opt out (e.g. for a non-TLS testnet/dev origin) rather than
 * silently getting an insecure cookie by forgetting the option. This guards
 * against a testnet/mainnet misconfiguration shipping a Secure-less cookie
 * on a production (mainnet) origin.
 *
 * @see https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
 */

const SESSION_COOKIE_NAME = "mux_session";

/** Single source of truth for the cookie's shared attributes. */
const SESSION_COOKIE_ATTRIBUTES = {
	path: "/",
	httpOnly: true,
	sameSite: "Lax",
};

function baseAttributes(secure) {
	const attrs = [
		`Path=${SESSION_COOKIE_ATTRIBUTES.path}`,
		SESSION_COOKIE_ATTRIBUTES.httpOnly ? "HttpOnly" : null,
		`SameSite=${SESSION_COOKIE_ATTRIBUTES.sameSite}`,
	].filter(Boolean);
	if (secure) attrs.push("Secure");
	return attrs;
}

/**
 * Builds the `Set-Cookie` value used by the login path.
 *
 * @param {string} value - the session token to store.
 * @param {{expiresAt?: number, secure?: boolean}} [options]
 *   `secure` defaults to `true` (fail closed) when omitted.
 * @returns {string}
 */
function buildSessionCookie(value, options = {}) {
	const { expiresAt, secure = true } = options;
	const now = Date.now();
	const expiresAtMs = typeof expiresAt === "number" ? expiresAt : now;
	const maxAgeSeconds = Math.max(0, Math.round((expiresAtMs - now) / 1000));

	const attrs = baseAttributes(secure);
	attrs.push(`Max-Age=${maxAgeSeconds}`);
	attrs.push(`Expires=${new Date(expiresAtMs).toUTCString()}`);

	return `${SESSION_COOKIE_NAME}=${value}; ${attrs.join("; ")}`;
}

/**
 * Builds the `Set-Cookie` value used by the logout path. Mirrors
 * `buildSessionCookie`'s attributes (minus `Secure`, irrelevant once the
 * value is being deleted) so the clear always matches whatever was set.
 *
 * @returns {string}
 */
function buildClearSessionCookie() {
	const attrs = baseAttributes(false);
	attrs.push("Max-Age=0");
	attrs.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
	return `${SESSION_COOKIE_NAME}=; ${attrs.join("; ")}`;
}

function readAttribute(cookieStr, attrName) {
	const segments = cookieStr.split(";").slice(1);
	const needle = attrName.toLowerCase();
	for (const segment of segments) {
		const trimmed = segment.trim();
		const idx = trimmed.indexOf("=");
		if (idx === -1) continue;
		const key = trimmed.slice(0, idx).trim().toLowerCase();
		if (key === needle) {
			return trimmed.slice(idx + 1).trim();
		}
	}
	return null;
}

/**
 * Parses the `name=value` pair off the front of a cookie string.
 *
 * Fails closed: returns `null` (never throws, never a partial object) for
 * anything that isn't a well-formed `SESSION_COOKIE_NAME=<non-empty value>`
 * pair -- including a missing `=`, an empty name, or an empty value.
 *
 * @param {string | undefined | null} cookieStr
 * @returns {{name: string, value: string} | null}
 */
function parseSessionCookie(cookieStr) {
	if (typeof cookieStr !== "string" || cookieStr.length === 0) {
		return null;
	}

	const first = cookieStr.split(";")[0] ?? "";
	const idx = first.indexOf("=");
	if (idx === -1) {
		return null;
	}

	const name = first.slice(0, idx).trim();
	const value = first.slice(idx + 1).trim();
	if (!name || !value || name !== SESSION_COOKIE_NAME) {
		return null;
	}

	return { name, value };
}

/**
 * Validates a session cookie string end-to-end: presence, well-formedness,
 * expiry, and (when the caller supplies them) role/revocation checks.
 * Deny-by-default -- any unrecognized/ambiguous input is rejected, never
 * silently accepted.
 *
 * `role`/`revoked` are not derived from the cookie itself; the caller
 * supplies them from whatever server-side session/role lookup it already
 * did, and this function applies the uniform accept/deny policy.
 *
 * @param {string | undefined | null} cookieStr
 * @param {{now?: number, requiredRole?: string, role?: string, revoked?: boolean}} [options]
 * @returns {{ok: true, value: string} | {ok: false, error: "SESSION_MISSING" | "SESSION_MALFORMED" | "SESSION_EXPIRED" | "SESSION_FORBIDDEN" | "SESSION_REVOKED"}}
 */
function validateSessionCookie(cookieStr, options = {}) {
	const { now = Date.now(), requiredRole, role, revoked } = options;

	if (!cookieStr) {
		return { ok: false, error: "SESSION_MISSING" };
	}

	const parsed = parseSessionCookie(cookieStr);
	if (!parsed) {
		return { ok: false, error: "SESSION_MALFORMED" };
	}

	let expired = false;
	const maxAgeRaw = readAttribute(cookieStr, "Max-Age");
	if (maxAgeRaw !== null) {
		const maxAge = Number(maxAgeRaw);
		if (Number.isFinite(maxAge) && maxAge <= 0) {
			expired = true;
		}
	}
	if (!expired) {
		const expiresRaw = readAttribute(cookieStr, "Expires");
		if (expiresRaw) {
			const expiresAtMs = Date.parse(expiresRaw);
			if (Number.isFinite(expiresAtMs) && now >= expiresAtMs) {
				expired = true;
			}
		}
	}
	if (expired) {
		return { ok: false, error: "SESSION_EXPIRED" };
	}

	// Deny-by-default: a revoked session is rejected outright, regardless
	// of whether its role would otherwise satisfy requiredRole.
	if (revoked) {
		return { ok: false, error: "SESSION_REVOKED" };
	}

	if (requiredRole && role !== requiredRole) {
		return { ok: false, error: "SESSION_FORBIDDEN" };
	}

	return { ok: true, value: parsed.value };
}

module.exports = {
	SESSION_COOKIE_NAME,
	SESSION_COOKIE_ATTRIBUTES,
	buildSessionCookie,
	buildClearSessionCookie,
	parseSessionCookie,
	validateSessionCookie,
};
