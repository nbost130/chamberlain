/** The overhead numbers in the Decisions view: the payload the page reads, and what the pinned view shows. */
import { describe, expect, test } from "bun:test";
import { overheadView } from "../core/overhead/format.ts";
import { OVERHEAD_KEY, type OverheadState, type OverheadSummary } from "../core/overhead/trigger.ts";
import { run, settle } from "../testing/inline-dom.ts";
import { fetchWake } from "../testing/wake.ts";
import { useWebWebFixtures } from "../testing/web-web-fixtures.ts";

const { setup } = useWebWebFixtures(fetchWake);

const last: OverheadSummary = {
	at: Date.parse("2026-11-18T12:00:00Z"),
	windowLabel: "24 h",
	trailingLabel: "7 d",
	prStatus: "ok",
	fleetStatus: "ok",
	costPerPrDay: 4.25,
	costPerPrTrailing: 3.5,
	prsDay: 20,
	stewardUsdDay: 85,
	noopRate: 0.287,
	spendShare: 0.476,
	stewardShare: 0.3,
	crossings: ["no-op wake rate 28.7% (149 of 520 wakes made no tool call), above 10.0%"],
	unavailable: [],
};
const state = (o: Partial<OverheadState> = {}): OverheadState => ({ last, investigations: [], ...o });

describe("the view's payload", () => {
	test("is null before the first measurement", () => {
		expect(overheadView({ investigations: [] })).toBeNull();
	});

	test("carries the managed overhead ratio with its coverage: partial below full coverage, and why when there is none", () => {
		const managed = {
			status: "ok" as const,
			threads: 167,
			mapped: 162,
			coverage: 162 / 167,
			ratio: 0.245,
			minCoverage: 0.9,
		};
		const line = (m: object) => overheadView(state({ last: { ...last, managed: m as never } }))?.line;
		expect(line(managed)).toContain(
			"managed overhead 24.5%, PARTIAL, coverage 97.0% (162 of 167 threads have sessions)",
		);
		expect(line({ ...managed, coverage: 1, mapped: 167 })).toContain(
			"managed overhead 24.5% (167 of 167 threads have sessions)",
		);
		expect(line({ ...managed, ratio: undefined })).toContain(
			"managed overhead unavailable (coverage 97.0% of 167 threads)",
		);
		expect(line({ status: "not-configured", minCoverage: 0.9 })).toContain("managed overhead not configured");
		expect(line({ status: "unavailable", minCoverage: 0.9 })).toContain("managed overhead unavailable");
	});

	test("carries the line with cost per PR (window and trailing), PRs merged, Steward spend, no-op rate and share, and what crossed", () => {
		const v = overheadView(state());
		expect(v?.line).toBe(
			"$4.25/PR 24 h · $3.50/PR 7 d · 20 PRs merged · Steward $85.00 · no-op 28.7% · overhead share 47.6% (Steward only 30.0%)",
		);
		expect(v?.crossed).toHaveLength(1);
		expect(v?.open).toBeNull();
	});

	test("says 'not configured' for what the operator has not asked for, and 'unavailable' for what failed", () => {
		const { costPerPrDay: _a, costPerPrTrailing: _b, prsDay: _c, spendShare: _d, ...rest } = last;
		const notConfigured = overheadView(
			state({ last: { ...rest, prStatus: "not-configured", fleetStatus: "not-configured" } }),
		);
		expect(notConfigured?.line).toContain("not configured/PR 24 h");
		expect(notConfigured?.line).toContain("not configured PRs merged");
		expect(notConfigured?.line).toContain("share not configured");
		const failed = overheadView(
			state({
				last: { ...rest, prStatus: "unavailable", fleetStatus: "unavailable", unavailable: ["merged PRs: down"] },
			}),
		);
		expect(failed?.line).toContain("unavailable/PR 24 h");
		expect(failed?.line).toContain("share unavailable");
		expect(failed?.unavailable).toEqual(["merged PRs: down"]);
	});

	test("names the investigation open now", () => {
		const open = { id: "OV-1", openedAt: 1, status: "open" as const, crossings: [] };
		expect(overheadView(state({ investigations: [open] }))?.open).toBe("OV-1");
		expect(overheadView(state({ investigations: [{ ...open, status: "closed" }] }))?.open).toBeNull();
	});

	test("/api/queue serves it, without touching the queue", async () => {
		const s = setup();
		expect((await (await s.get("/api/queue")).json()).overhead).toBeNull();
		s.store.state.set(OVERHEAD_KEY, state());
		const data = await (await s.get("/api/queue", { origin: "null" })).json();
		expect(data.overhead.line).toContain("$4.25/PR 24 h");
		expect(data.items).toEqual([]);
	});
});

describe("the pinned view", () => {
	const health = {
		at: new Date().toISOString(),
		verdict: "OK",
		tokens: 1000,
		replies: 1,
		breaks: 0,
		selfReads: 0,
		threadRereads: 0,
		elevated: [],
		unknown: [],
		report: "r",
	};
	const limits = { context: 200000, compactContext: 350000, selfReads: 3, threadRereads: 4 };

	test("shows the overhead line, each limit crossed, the open investigation and what could not be read", async () => {
		const overhead = {
			...overheadView(state({ investigations: [{ id: "OV-9", openedAt: 1, status: "open", crossings: [] }] })),
			unavailable: ["fleet spend: down"],
		};
		const dq = run(() => ({ items: [], health, healthLimits: limits, overhead }));
		await settle();
		expect(dq.textContent).toContain("Overhead (24 h)");
		expect(dq.textContent).toContain("$4.25/PR 24 h · $3.50/PR 7 d · 20 PRs merged");
		expect(dq.textContent).toContain("Over threshold: no-op wake rate 28.7%");
		expect(dq.textContent).toContain("Investigation OV-9 is open.");
		expect(dq.textContent).toContain("Unavailable: fleet spend: down");
	});

	test("shows nothing about overhead before there is a measurement", async () => {
		const dq = run(() => ({ items: [], health, healthLimits: limits, overhead: null }));
		await settle();
		expect(dq.textContent).not.toContain("Overhead");
	});
});
