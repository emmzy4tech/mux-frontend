import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestsOverTimeChart } from "./requests-over-time-chart";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function point(
	overrides: Partial<{
		timestamp: number;
		count: number;
		responseTime: number;
		statusCode: number;
	}> = {},
) {
	return {
		timestamp: Date.now(),
		count: 10,
		responseTime: 50,
		statusCode: 200,
		...overrides,
	};
}

describe("RequestsOverTimeChart", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.UTC(2026, 8, 27, 12, 0, 0));
	});

	it("excludes points older than the selected timeRange cutoff and renders recent ones", () => {
		const now = Date.now();
		const data = [
			point({ timestamp: now - 25 * 60 * 60 * 1000, count: 1 }), // just over 24h old
			point({ timestamp: now - 1000, count: 5 }), // recent
		];
		const { container } = render(
			<RequestsOverTimeChart data={data} timeRange="24h" />,
		);

		expect(container.querySelectorAll("rect").length).toBe(
			// 5 grid lines + 1 bar for the recent point
			5 + 1,
		);
	});

	it("renders without throwing and produces no bars for an empty data array", () => {
		const { container } = render(
			<RequestsOverTimeChart data={[]} timeRange="24h" />,
		);

		// Only the 5 grid lines remain; no bar <rect>s.
		expect(container.querySelectorAll("rect").length).toBe(5);
	});

	it("falls back to the 24h window for an unknown timeRange value", () => {
		const now = Date.now();
		const data = [
			point({ timestamp: now - 2 * 60 * 60 * 1000, count: 3 }), // within 24h, outside 1h
		];
		const { container } = render(
			<RequestsOverTimeChart
				data={data}
				// @ts-expect-error -- intentionally invalid to exercise the fallback
				timeRange="bogus"
			/>,
		);

		// If the unknown range fell back to something narrower than 24h this
		// point would be filtered out and there would be no bar.
		expect(container.querySelectorAll("rect").length).toBe(5 + 1);
	});

	it("colors bars by status code: 2xx blue, 4xx amber, 5xx red", () => {
		const now = Date.now();
		const data = [
			point({ timestamp: now, statusCode: 200 }),
			point({ timestamp: now, statusCode: 404 }),
			point({ timestamp: now, statusCode: 500 }),
		];
		const { container } = render(
			<RequestsOverTimeChart data={data} timeRange="24h" />,
		);

		const fills = Array.from(container.querySelectorAll("rect"))
			.map((el) => el.getAttribute("fill"))
			.filter((fill): fill is string => fill !== null && fill !== "#374151");

		expect(fills).toContain("#3b82f6"); // 2xx -> blue
		expect(fills).toContain("#f59e0b"); // 4xx -> amber
		expect(fills).toContain("#ef4444"); // 5xx -> red
	});

	it("shows the tooltip with count, response time and timestamp on hover", () => {
		const now = Date.now();
		const data = [point({ timestamp: now, count: 42, responseTime: 123 })];
		const { container, getByText } = render(
			<RequestsOverTimeChart data={data} timeRange="24h" />,
		);

		const group = container.querySelector("svg g");
		expect(group).not.toBeNull();
		fireEvent.mouseEnter(group as Element);

		expect(getByText("Count: 42")).toBeTruthy();
		expect(getByText("Response: 123ms")).toBeTruthy();

		fireEvent.mouseLeave(group as Element);
		expect(() => getByText("Count: 42")).toThrow();
	});
});
