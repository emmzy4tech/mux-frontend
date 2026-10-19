/**
 * Guards the login error-code contract shared between
 * tests/e2e/real-backend/login.spec.ts and tests/e2e/real-backend/helpers.ts
 * (see that directory's README.md).
 *
 * login.spec.ts used to define its own local `LOGIN_ERROR_CODES` object
 * instead of importing the one `helpers.ts` exports, so the two could drift
 * silently, and the spec asserted a `missingCredentials` code that wasn't
 * even part of the shared contract. This file is the single source of
 * truth check: there must be exactly one `LOGIN_ERROR_CODES` definition
 * (in helpers.ts), the spec must import it rather than redefine it, and
 * every `LOGIN_ERROR_CODES.<key>` the spec asserts against must be a real
 * member of the exported `LoginErrorCode` union.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LOGIN_ERROR_CODES } from "./e2e/real-backend/helpers";

const loginSpecPath = resolve(
	__dirname,
	"e2e/real-backend/login.spec.ts",
);
const loginSpecSource = readFileSync(loginSpecPath, "utf8");

describe("login.spec.ts / helpers.ts LOGIN_ERROR_CODES contract", () => {
	it("imports LOGIN_ERROR_CODES from ./helpers instead of defining its own copy", () => {
		expect(loginSpecSource).toMatch(
			/import\s*\{[^}]*LOGIN_ERROR_CODES[^}]*\}\s*from\s*["']\.\/helpers["']/,
		);
	});

	it("contains no second literal definition of LOGIN_ERROR_CODES", () => {
		expect(loginSpecSource).not.toMatch(
			/(?:const|let|var)\s+LOGIN_ERROR_CODES\s*=/,
		);
	});

	it("every LOGIN_ERROR_CODES.<key> asserted in the spec is a real member of the shared contract", () => {
		const usedKeys = new Set<string>();
		for (const match of loginSpecSource.matchAll(
			/LOGIN_ERROR_CODES\.([A-Za-z0-9_]+)/g,
		)) {
			usedKeys.add(match[1]);
		}

		// The spec must actually reference the shared contract, not just
		// import it unused.
		expect(usedKeys.size).toBeGreaterThan(0);

		for (const key of usedKeys) {
			expect(
				Object.prototype.hasOwnProperty.call(LOGIN_ERROR_CODES, key),
				`LOGIN_ERROR_CODES.${key} is asserted in login.spec.ts but is not a ` +
					"member of the shared contract exported by helpers.ts",
			).toBe(true);
		}
	});

	it("the shared contract defines a code for the missing-credentials case", () => {
		expect(LOGIN_ERROR_CODES.missingCredentials).toBe(
			"AUTH_MISSING_CREDENTIALS",
		);
	});
});
