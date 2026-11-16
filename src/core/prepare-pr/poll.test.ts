import { describe, expect, test } from "bun:test";
import { parseCheckOutput } from "../sweep/sweep-findings.ts";
import { pollPreparePr } from "./poll.ts";

const ONE_WAY_FIXTURE = `current_branch: main
other_branch_run:
  id: "01FIXTUREONEWAY0000000001"
  branch: pilot/one-way
  status: running
  awaiting_agent: parked 5m0s
  head: deadbeef
gate:
  step: gate.review.one-way-door
  status: awaiting_approval
`;

const LINT_FIXTURE = `current_branch: main
other_branch_run:
  id: "01FIXTURELINT0000000000001"
  branch: fix/lint-parked
  status: running
  awaiting_agent: parked 20m0s
  head: cafebabe
gate:
  step: lint
  status: awaiting_approval
`;

const OVERVIEW = `other_branch_active_run:
  id: "01FIXTUREONEWAY0000000001"
  branch: pilot/one-way
  status: running
`;

describe("pollPreparePr with fixtures (no live MemberHero)", () => {
	test("fixture axi status → findings JSON accepted by parseCheckOutput", async () => {
		const fixtures = new Map([
			[
				"MemberHero",
				new Map([
					["__overview__", OVERVIEW],
					["01FIXTUREONEWAY0000000001", ONE_WAY_FIXTURE],
					["01FIXTURELINT0000000000001", LINT_FIXTURE],
				]),
			],
		]);
		const findings = await pollPreparePr({
			repos: [{ name: "MemberHero", path: "/tmp/no-such-repo" }],
			fixtures,
			exec: async () => {
				throw Error("live exec must not run in fixture test");
			},
		});
		// Overview only lists one-way run; lint fixture is not discovered unless in overview/db.
		expect(findings).toHaveLength(1);
		expect(findings[0]!.dedupKey).toBe("prepare-pr:01FIXTUREONEWAY0000000001");
		expect(findings[0]!.text).toContain("[URGENT]");
		expect(parseCheckOutput(JSON.stringify(findings))).toEqual(findings);
	});

	test("malformed axi status fails closed", async () => {
		const fixtures = new Map([
			[
				"MemberHero",
				new Map([
					["__overview__", OVERVIEW],
					["01FIXTUREONEWAY0000000001", "not axi output"],
				]),
			],
		]);
		await expect(
			pollPreparePr({
				repos: [{ name: "MemberHero", path: "/tmp/x" }],
				fixtures,
				exec: async () => {
					throw Error("no live");
				},
			}),
		).rejects.toThrow(/missing run id|axi status/);
	});

	test("both fixture runs when overview lists neither but fixture map has them", async () => {
		const fixtures = new Map([
			[
				"MemberHero",
				new Map([
					["__overview__", "daemon: running\n"],
					["01FIXTUREONEWAY0000000001", ONE_WAY_FIXTURE],
					["01FIXTURELINT0000000000001", LINT_FIXTURE],
				]),
			],
		]);
		const findings = await pollPreparePr({
			repos: [{ name: "MemberHero", path: "/tmp/x" }],
			fixtures,
			exec: async () => {
				throw Error("no live");
			},
		});
		expect(findings.map((f) => f.dedupKey).sort()).toEqual([
			"prepare-pr:01FIXTURELINT0000000000001",
			"prepare-pr:01FIXTUREONEWAY0000000001",
		]);
	});
});
