import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { contrastRatio, NETWORK_BADGE_STYLES, NetworkBadge } from "./NetworkBadge";

const WCAG_AA_TEXT = 4.5;

afterEach(() => {
	cleanup();
});

describe("NETWORK_BADGE_STYLES", () => {
	it.each(Object.entries(NETWORK_BADGE_STYLES))(
		"%s meets WCAG 2.1 AA (>= 4.5:1)",
		(_network, { bg, fg }) => {
			expect(contrastRatio(bg, fg)).toBeGreaterThanOrEqual(WCAG_AA_TEXT);
		},
	);
});

describe("contrastRatio", () => {
	it("is symmetric", () => {
		const { bg, fg } = NETWORK_BADGE_STYLES.testnet;

		expect(contrastRatio(bg, fg)).toBe(contrastRatio(fg, bg));
		expect(contrastRatio("#000000", "#FFFFFF")).toBe(
			contrastRatio("#FFFFFF", "#000000"),
		);
	});

	it("returns 1 for identical colours", () => {
		expect(contrastRatio("#FFFFFF", "#FFFFFF")).toBe(1);
		expect(contrastRatio("#065F46", "#065F46")).toBe(1);
	});

	it("returns 21 for black on white", () => {
		expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
	});
});

describe("NetworkBadge", () => {
	it.each(["devnet", "", "Mainnet", "mainnet ", "TESTNET"])(
		"fails closed to the Unknown network style for %j",
		(network) => {
			render(<NetworkBadge network={network} />);
			const badge = screen.getByRole("status");
			const { label, bg, fg } = NETWORK_BADGE_STYLES.unknown;

			expect(badge.textContent).toBe(label);
			expect(badge.textContent).toBe("Unknown network");
			expect(badge.getAttribute("aria-label")).toBe("Network: Unknown network");
			expect(badge).toHaveStyle({ backgroundColor: bg, color: fg });
		},
	);

	it.each(["mainnet", "testnet", "futurenet"] as const)(
		"renders the %s label and colours for a known network",
		(network) => {
			render(<NetworkBadge network={network} />);
			const badge = screen.getByRole("status");
			const { label, bg, fg } = NETWORK_BADGE_STYLES[network];

			expect(badge.textContent).toBe(label);
			expect(badge).toHaveStyle({ backgroundColor: bg, color: fg });
		},
	);
});
