import { describe, expect, it } from "vitest";
import { MOCK_AUDIT_ENTRIES, MOCK_AUDIT_ENTRY_COUNT } from "./mock-entries";

describe("MOCK_AUDIT_ENTRIES", () => {
	it("has exactly MOCK_AUDIT_ENTRY_COUNT entries", () => {
		expect(MOCK_AUDIT_ENTRIES.length).toBe(MOCK_AUDIT_ENTRY_COUNT);
	});

	it("has unique, zero-padded ids", () => {
		const ids = MOCK_AUDIT_ENTRIES.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(MOCK_AUDIT_ENTRY_COUNT);
		for (const id of ids) {
			expect(id).toMatch(/^evt_\d{4}$/);
		}
	});

	it("anchors the first entry's timestamp to the documented epoch", () => {
		expect(MOCK_AUDIT_ENTRIES[0].createdAt).toBe(new Date(Date.UTC(2026, 0, 1)).toISOString());
	});

	it("shares a createdAt timestamp between at least one adjacent pair, exercising the id tie-break", () => {
		const hasTieBreakPair = MOCK_AUDIT_ENTRIES.some(
			(entry, i) => i + 1 < MOCK_AUDIT_ENTRIES.length && entry.createdAt === MOCK_AUDIT_ENTRIES[i + 1].createdAt,
		);
		expect(hasTieBreakPair).toBe(true);
	});
});
