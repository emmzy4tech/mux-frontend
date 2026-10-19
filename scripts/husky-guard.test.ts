import { execSync } from "child_process";
import * as fs from "fs";
import { readFileSync } from "fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HuskyPreCommitGuard } from "./husky-guard";

vi.mock("child_process", () => ({
	execSync: vi.fn(),
}));

const REPORT_PATH = ".husky/_guard-report.json";

describe("HuskyPreCommitGuard", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.mocked(execSync).mockReset();
		if (fs.existsSync(REPORT_PATH)) {
			fs.rmSync(REPORT_PATH);
		}
	});

	it("lists the un-run checks as skipped when failFast stops the run early", async () => {
		vi.mocked(execSync).mockImplementation(() => {
			throw new Error("lint failed");
		});

		const guard = new HuskyPreCommitGuard({
			checks: ["lint", "typecheck", "test", "security"],
			failFast: true,
			reportPath: REPORT_PATH,
		});

		await guard.runGuard();

		const report = JSON.parse(fs.readFileSync(REPORT_PATH, "utf8"));
		expect(report.summary.skipped).toEqual(["typecheck", "test", "security"]);
		expect(report.summary.total).toBe(1);
		expect(report.summary.failed).toBe(1);
		expect(report.passed).toBe(false);
	});

	it("does not write a report file when the guard is disabled", async () => {
		vi.mocked(execSync).mockImplementation(() => Buffer.from(""));

		const guard = new HuskyPreCommitGuard({
			enabled: false,
			checks: ["lint"],
			reportPath: REPORT_PATH,
		});

		// Call runGuard() directly (not preCommit()) -- the bug this guards
		// against is that any caller reaching runGuard() still wrote a
		// report, even when the guard is disabled.
		await guard.runGuard();

		expect(fs.existsSync(REPORT_PATH)).toBe(false);
	});

	it("sets the report's passed flag to false when any executed check failed", async () => {
		vi.mocked(execSync).mockImplementation((command: string) => {
			if (command.includes("eslint")) {
				throw new Error("lint failed");
			}
			return Buffer.from("");
		});

		const guard = new HuskyPreCommitGuard({
			checks: ["lint", "typecheck"],
			failFast: false,
			reportPath: REPORT_PATH,
		});

		await guard.runGuard();

		const report = JSON.parse(fs.readFileSync(REPORT_PATH, "utf8"));
		expect(report.passed).toBe(false);
		expect(report.summary.skipped).toEqual([]);
	});

	it("runs the vitest command for the test check", async () => {
		const guard = new HuskyPreCommitGuard({ checks: ["test"], failFast: false });
		const [result] = await guard.runGuard();

		expect(execSync).toHaveBeenCalledWith("npx vitest run", expect.anything());
		expect(result.passed).toBe(true);
	});

	it("runs the eslint command for the lint check", async () => {
		const guard = new HuskyPreCommitGuard({ checks: ["lint"], failFast: false });
		await guard.runGuard();

		expect(execSync).toHaveBeenCalledWith(
			"npx eslint --max-warnings 0",
			expect.anything(),
		);
	});

	it("runs the tsc command for the typecheck check", async () => {
		const guard = new HuskyPreCommitGuard({ checks: ["typecheck"], failFast: false });
		await guard.runGuard();

		expect(execSync).toHaveBeenCalledWith("npx tsc --noEmit", expect.anything());
	});

	it("fails closed on an unknown check without invoking execSync", async () => {
		const guard = new HuskyPreCommitGuard({
			checks: ["some-unknown-check"],
			failFast: false,
		});
		const [result] = await guard.runGuard();

		expect(execSync).not.toHaveBeenCalled();
		expect(result.passed).toBe(false);
		expect(result.errors[0]).toContain("Unsupported pre-commit check");
	});

	it("never shells out to jest or audit-ci, which are not repo dependencies", () => {
		const source = readFileSync(new URL("./husky-guard.ts", import.meta.url), "utf8");

		expect(source).not.toContain("jest");
		expect(source).not.toContain("audit-ci");
	});
});
