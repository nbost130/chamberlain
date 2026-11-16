import { describe, expect, test } from "bun:test";
import { parseCheckOutput } from "../sweep/sweep-findings.ts";
import type { AxiParkedRun } from "./axi-parse.ts";
import { parkedKind, preparePrFindings } from "./findings.ts";
import { ONE_WAY_DOOR_URGENT_MS, OTHER_GATE_WAKE_MS } from "./thresholds.ts";

const run = (over: Partial<AxiParkedRun> = {}): AxiParkedRun => ({
	runId: "01TEST",
	branch: "feat/x",
	status: "running",
	head: "abc12345",
	gateStep: "gate.review.one-way-door",
	gateStatus: "awaiting_approval",
	parkedMs: ONE_WAY_DOOR_URGENT_MS + 1,
	...over,
});

describe("parkedKind", () => {
	test("one-way-door over 1m is urgent", () => {
		expect(parkedKind(run(), Date.now())).toBe("one-way-urgent");
		expect(parkedKind(run({ parkedMs: ONE_WAY_DOOR_URGENT_MS }), Date.now())).toBeNull();
	});
	test("other gates need 15m", () => {
		expect(parkedKind(run({ gateStep: "lint", parkedMs: OTHER_GATE_WAKE_MS }), Date.now())).toBeNull();
		expect(parkedKind(run({ gateStep: "gate.test.test-scope", parkedMs: OTHER_GATE_WAKE_MS + 1 }), Date.now())).toBe(
			"other-gate",
		);
	});
	test("not awaiting_approval yields nothing", () => {
		expect(parkedKind(run({ gateStatus: "completed" }), Date.now())).toBeNull();
	});
});

describe("preparePrFindings", () => {
	test("emits urgent finding with prepare-pr:runId dedup and parseCheckOutput shape", () => {
		const f = preparePrFindings({ repo: "MemberHero", runs: [run()], nowMs: Date.now() });
		expect(f).toHaveLength(1);
		expect(f[0]!.dedupKey).toBe("prepare-pr:01TEST");
		expect(f[0]!.text).toContain("[URGENT]");
		expect(f[0]!.text).toContain("gate.review.one-way-door");
		expect(f[0]!.text).toContain("awaiting_approval");
		expect(f[0]!.repeatIntervalMs).toBe(ONE_WAY_DOOR_URGENT_MS);
		expect(f[0]!.subject).toEqual({ kind: "run", id: "01TEST" });
		expect(parseCheckOutput(JSON.stringify(f))).toEqual(f);
	});
	test("other gate is non-urgent text", () => {
		const f = preparePrFindings({
			repo: "MemberHero",
			runs: [run({ gateStep: "lint", parkedMs: OTHER_GATE_WAKE_MS + 1000 })],
			nowMs: Date.now(),
		});
		expect(f[0]!.text).not.toContain("[URGENT]");
		expect(f[0]!.text).toContain("parked at lint");
	});
	test("settled mismatch when linked thread settled and run still open", () => {
		const f = preparePrFindings({
			repo: "MemberHero",
			runs: [run({ gateStep: "lint", parkedMs: OTHER_GATE_WAKE_MS + 1 })],
			nowMs: Date.now(),
			links: [
				{
					threadId: "thr-1",
					runId: "01TEST",
					repo: "MemberHero",
					startedAt: 1,
					clearedAt: null,
				},
			],
			settledThreadIds: new Set(["thr-1"]),
		});
		expect(f.map((x) => x.dedupKey).sort()).toEqual(["prepare-pr:01TEST", "prepare-pr:settled-mismatch:01TEST"]);
		expect(f.find((x) => x.dedupKey.includes("settled"))!.text).toContain("thr-1");
	});
});
