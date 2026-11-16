import { describe, expect, test } from "bun:test";
import { parseAxiOverviewActiveRunIds, parseAxiStatus, parseParkedDuration } from "./axi-parse.ts";

const STATUS_ONE_WAY = `current_branch: main
other_branch_run:
  id: "01M7H0FDJ93WBEV2H0NWN8A51C"
  branch: pilot/701-staff-member-journey
  status: running
  awaiting_agent: parked 23m27s
  head: 3d78eeda
  head_sha: 3d78eeda3a7bc7d55037f4e67fc3beb733786b01
  verification_plan: none
  findings: "1 awaiting, 1 info"
  steps[12]{step,status,findings,duration_ms}:
    intent,completed,0,351
    gate.review.one-way-door,awaiting_approval,1,123
    lint,pending,0,0
gate:
  step: gate.review.one-way-door
  status: awaiting_approval
  summary: "review needed"
help[1]: respond with approve
`;

const STATUS_LINT = `current_branch: main
other_branch_run:
  id: "01M7AWJPN1KEXE1V0KYV9N54FY"
  branch: t3/receipt-replay-window
  status: running
  awaiting_agent: parked 2d10h
  head: 860b13bf
  head_sha: 860b13bf0eaba334d628cb79a2835547530f3442
gate:
  step: lint
  status: awaiting_approval
`;

const OVERVIEW = `daemon: running
other_branch_active_run:
  id: "01M7AWJPN1KEXE1V0KYV9N54FY"
  branch: t3/receipt-replay-window
  status: running
  awaiting_agent: parked 2d10h
  head: 860b13bf
count: 10 of 396 total
runs[10]{id,branch,status,head,pr}:
  "01M7GJPVS1KACPHAVS3KAHHV3G",fix/x,completed,f4650ae2,""
`;

describe("parseParkedDuration", () => {
	test("parses minutes and seconds", () => {
		expect(parseParkedDuration("parked 23m27s")).toBe((23 * 60 + 27) * 1000);
	});
	test("parses days and hours", () => {
		expect(parseParkedDuration("parked 2d10h")).toBe((2 * 86_400 + 10 * 3_600) * 1000);
	});
	test("refuses nonsense", () => {
		expect(parseParkedDuration("idle 5m")).toBeNull();
		expect(parseParkedDuration("parked")).toBeNull();
		expect(parseParkedDuration("parked garbage2mgarbage")).toBeNull();
	});
});

describe("parseAxiStatus", () => {
	test("reads one-way-door gate and parked duration", () => {
		const r = parseAxiStatus(STATUS_ONE_WAY, "01M7H0FDJ93WBEV2H0NWN8A51C");
		expect(r).toMatchObject({
			runId: "01M7H0FDJ93WBEV2H0NWN8A51C",
			branch: "pilot/701-staff-member-journey",
			status: "running",
			head: "3d78eeda",
			gateStep: "gate.review.one-way-door",
			gateStatus: "awaiting_approval",
			parkedMs: (23 * 60 + 27) * 1000,
		});
	});
	test("reads lint gate parked for days", () => {
		const r = parseAxiStatus(STATUS_LINT);
		expect(r.gateStep).toBe("lint");
		expect(r.parkedMs).toBe((2 * 86_400 + 10 * 3_600) * 1000);
	});
	test("fail closed on empty or missing id", () => {
		expect(() => parseAxiStatus("")).toThrow("empty");
		expect(() => parseAxiStatus("current_branch: main\ngate:\n  step: lint\n")).toThrow("missing run id");
	});
	test("fail closed on run id mismatch", () => {
		expect(() => parseAxiStatus(STATUS_ONE_WAY, "OTHER")).toThrow("expected run");
	});
	test("fail closed on unknown status", () => {
		expect(() =>
			parseAxiStatus(`other_branch_run:
  id: "R"
  branch: main
  status: nonsense
  head: deadbeef
`),
		).toThrow(/unknown status/);
	});
	test("fail closed when parked without a complete gate", () => {
		expect(() =>
			parseAxiStatus(`other_branch_run:
  id: "R"
  branch: main
  status: running
  awaiting_agent: parked 20m
  head: deadbeef
`),
		).toThrow(/complete gate/);
	});
	test("fail closed when top-level status is awaiting_approval without gate/age", () => {
		expect(() =>
			parseAxiStatus(`other_branch_run:
  id: "R"
  branch: main
  status: awaiting_approval
  head: deadbeef
`),
		).toThrow(/complete gate/);
	});
	test("fail closed when awaiting gate has no timing and caller has no fallback", () => {
		expect(() =>
			parseAxiStatus(`other_branch_run:
  id: "R"
  branch: main
  status: running
  head: deadbeef
gate:
  step: gate.review.one-way-door
  status: awaiting_approval
`),
		).not.toThrow();
		const r = parseAxiStatus(`other_branch_run:
  id: "R"
  branch: main
  status: running
  head: deadbeef
gate:
  step: gate.review.one-way-door
  status: awaiting_approval
`);
		expect(r.parkedMs).toBeNull();
		expect(r.gateStatus).toBe("awaiting_approval");
	});
});

describe("parseAxiOverviewActiveRunIds", () => {
	test("reads other_branch_active_run id", () => {
		expect(parseAxiOverviewActiveRunIds(OVERVIEW)).toEqual(["01M7AWJPN1KEXE1V0KYV9N54FY"]);
	});
});
