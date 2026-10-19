import { describe, expect, it } from "vitest";
import { criticalStrings, getCriticalString } from "./critical-strings";

describe("criticalStrings", () => {
	it("has only non-empty string values for every section/key pair", () => {
		for (const [, strings] of Object.entries(criticalStrings)) {
			for (const [, value] of Object.entries(strings)) {
				expect(typeof value).toBe("string");
				expect((value as string).length).toBeGreaterThan(0);
			}
		}
	});
});

describe("getCriticalString", () => {
	it("returns the exact literal for a wallet key", () => {
		expect(getCriticalString("wallet", "connectPrompt")).toBe("Connect your wallet to continue");
	});

	it("returns the exact literal for a payment key", () => {
		expect(getCriticalString("payment", "success")).toBe("Payment sent successfully");
	});

	it("returns the exact literal for an auth key", () => {
		expect(getCriticalString("auth", "sessionExpired")).toBe(
			"Your session has expired. Please sign in again.",
		);
	});

	it("rejects an unknown key at compile time", () => {
		// @ts-expect-error "doesNotExist" is not a key of the "wallet" section.
		getCriticalString("wallet", "doesNotExist");
	});
});
