import { afterEach, describe, expect, it, vi } from "vitest";
import { generateOGTags, validateManifest } from "./og-tags";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("generateOGTags", () => {
	it("returns openGraph title/description/type/siteName and the twitter card", () => {
		const tags = generateOGTags("My Title", "My description");

		expect(tags.openGraph?.title).toBe("My Title");
		expect(tags.openGraph?.description).toBe("My description");
		expect(tags.openGraph?.type).toBe("website");
		expect(tags.openGraph?.siteName).toBe("Mux Protocol");
		expect(tags.twitter?.card).toBe("summary_large_image");
		expect(tags.twitter?.title).toBe("My Title");
		expect(tags.twitter?.description).toBe("My description");
	});

	it("returns an empty images array when no image is provided", () => {
		const tags = generateOGTags("Title", "Description");

		expect(tags.openGraph?.images).toEqual([]);
	});

	it("returns a single 1200x630 image entry with alt === title when image is provided", () => {
		const tags = generateOGTags(
			"Title",
			"Description",
			"https://example.com/og.png",
		);

		expect(tags.openGraph?.images).toEqual([
			{
				url: "https://example.com/og.png",
				width: 1200,
				height: 630,
				alt: "Title",
			},
		]);
	});

	it("reflects NEXT_PUBLIC_SITE_URL when set", () => {
		vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://mux.example");
		const tags = generateOGTags("Title", "Description");

		expect(tags.openGraph?.url).toBe("https://mux.example");
	});

	it("leaves url undefined when NEXT_PUBLIC_SITE_URL is unset", () => {
		const previous = process.env.NEXT_PUBLIC_SITE_URL;
		delete process.env.NEXT_PUBLIC_SITE_URL;
		try {
			const tags = generateOGTags("Title", "Description");
			expect(tags.openGraph?.url).toBeUndefined();
		} finally {
			if (previous !== undefined) process.env.NEXT_PUBLIC_SITE_URL = previous;
		}
	});
});

describe("validateManifest", () => {
	function minimalManifest(): Record<string, unknown> {
		return {
			name: "Mux",
			short_name: "Mux",
			start_url: "/",
		};
	}

	it("returns valid:true with no errors for a minimal valid manifest", () => {
		expect(validateManifest(minimalManifest())).toEqual({
			valid: true,
			errors: [],
		});
	});

	it("reports a missing name", () => {
		const { name, ...rest } = minimalManifest();
		const result = validateManifest(rest);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("name is required");
	});

	it("reports a missing short_name", () => {
		const { short_name, ...rest } = minimalManifest();
		const result = validateManifest(rest);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("short_name is required");
	});

	it("reports a missing start_url", () => {
		const { start_url, ...rest } = minimalManifest();
		const result = validateManifest(rest);
		expect(result.valid).toBe(false);
		expect(result.errors).toContain("start_url is required");
	});

	it("rejects an invalid display value with the allow-list error", () => {
		const result = validateManifest({
			...minimalManifest(),
			display: "weird-mode",
		});
		expect(result.valid).toBe(false);
		expect(result.errors).toContain(
			"display must be one of: standalone, fullscreen, minimal-ui, browser",
		);
	});

	it("accepts a valid display value", () => {
		const result = validateManifest({
			...minimalManifest(),
			display: "standalone",
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toEqual([]);
	});
});
