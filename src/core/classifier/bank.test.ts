import { describe, expect, test } from "bun:test";
import { combine, DEFAULT_BANK, type Facts, parseBank, type Question } from "./bank.ts";

const IDS = [
	"asks_decision",
	"needs_principal_task",
	"repeated_failure",
	"partial_answer",
	"promises_more_work",
	"waiting_external",
	"claims_armed_wait",
	"work_finished",
];
/** Every question answered no, with the given ones overridden. */
const ans = (over: Record<string, number> = {}) => ({ ...Object.fromEntries(IDS.map((id) => [id, 0.02])), ...over });
const O = { thresholds: { default: 0.5 }, armedGraceMinutes: 360 };
const agent: Facts = { humanAsked: false, idleMinutes: 120 };
const human: Facts = { humanAsked: true, idleMinutes: 120 };
const act = (a: Record<string, number>, f: Facts = agent, o = O) => combine(DEFAULT_BANK, a, f, o).action;

describe("the default bank", () => {
	test("is the evaluated eight questions, each with an ask and both outcomes described", () => {
		expect(DEFAULT_BANK.map((q) => q.id)).toEqual(IDS);
		for (const q of DEFAULT_BANK)
			for (const k of ["ask", "yes", "no"] as const) expect(q[k].length).toBeGreaterThan(20);
		const fires = Object.fromEntries(DEFAULT_BANK.map((q) => [q.id, q.fires]));
		expect(fires).toEqual({
			asks_decision: "escalate",
			needs_principal_task: "escalate",
			repeated_failure: "escalate",
			partial_answer: "nudge",
			promises_more_work: "nudge",
			waiting_external: "nudge",
			claims_armed_wait: "modifier",
			work_finished: "settle",
		});
		const q = (id: string) => DEFAULT_BANK.find((x) => x.id === id)!;
		expect(q("partial_answer").requires).toEqual(["human_asked"]);
		expect(q("promises_more_work").unless).toEqual(["claims_armed_wait"]);
		expect(q("waiting_external").unless).toEqual(["work_finished", "claims_armed_wait"]);
	});
});

describe("combine: escalate > nudge > settle > ignore, decided in code", () => {
	test("any escalate question fires escalate, whatever else is yes, with the reasons strongest first", () => {
		const d = combine(
			DEFAULT_BANK,
			ans({ asks_decision: 0.98, needs_principal_task: 0.6, work_finished: 0.99 }),
			agent,
			O,
		);
		expect(d).toEqual({
			action: "escalate",
			reasons: [
				{ id: "asks_decision", p: 0.98 },
				{ id: "needs_principal_task", p: 0.6 },
			],
		});
		expect(act(ans({ repeated_failure: 0.7, promises_more_work: 0.9 }))).toBe("escalate");
	});
	test("partial_answer nudges only after a human's message (the gate that fixed Jev's 31 false positives)", () => {
		expect(act(ans({ partial_answer: 0.97 }), agent)).toBe("ignore");
		expect(act(ans({ partial_answer: 0.97, work_finished: 0.9 }), agent)).toBe("settle");
		expect(combine(DEFAULT_BANK, ans({ partial_answer: 0.97 }), human, O)).toEqual({
			action: "nudge",
			reasons: [{ id: "partial_answer", p: 0.97 }],
		});
	});
	test("partial_answer is not held by an armed wait: rule 2 comes before the armed-wait rule", () =>
		expect(act(ans({ partial_answer: 0.9, claims_armed_wait: 0.9 }), { ...human, idleMinutes: 30 })).toBe("nudge"));
	test("promises_more_work nudges, unless an armed wait is claimed and the thread is younger than the grace", () => {
		expect(act(ans({ promises_more_work: 0.8 }))).toBe("nudge");
		const young = { ...agent, idleMinutes: 359 };
		expect(combine(DEFAULT_BANK, ans({ promises_more_work: 0.8, claims_armed_wait: 0.7 }), young, O)).toEqual({
			action: "ignore",
			reasons: [{ id: "claims_armed_wait", p: 0.7 }],
		});
		// Idle past the grace: the wait it claims is gone (an idle parent has no running background task).
		expect(act(ans({ promises_more_work: 0.8, claims_armed_wait: 0.7 }), { ...agent, idleMinutes: 360 })).toBe("nudge");
		// The armed-wait rule holds the nudge even when the task also reads finished: the design's rule 3 stops at ignore.
		expect(act(ans({ promises_more_work: 0.8, claims_armed_wait: 0.7, work_finished: 0.9 }), young)).toBe("ignore");
	});
	test("waiting_external nudges unless work_finished; an armed wait holds it as for a promise", () => {
		expect(act(ans({ waiting_external: 0.9 }))).toBe("nudge");
		expect(act(ans({ waiting_external: 0.9, work_finished: 0.8 }))).toBe("settle");
		expect(act(ans({ waiting_external: 0.9, claims_armed_wait: 0.9 }), { ...agent, idleMinutes: 10 })).toBe("ignore");
		expect(act(ans({ waiting_external: 0.9, claims_armed_wait: 0.9 }), { ...agent, idleMinutes: 400 })).toBe("nudge");
	});
	test("work_finished alone settles; nothing at all is ignore; an armed-wait claim alone is ignore", () => {
		expect(combine(DEFAULT_BANK, ans({ work_finished: 0.96 }), agent, O)).toEqual({
			action: "settle",
			reasons: [{ id: "work_finished", p: 0.96 }],
		});
		expect(combine(DEFAULT_BANK, ans(), agent, O)).toEqual({ action: "ignore", reasons: [] });
		expect(act(ans({ claims_armed_wait: 0.99 }))).toBe("ignore");
	});
	test("thresholds: at or over fires; a per-question threshold overrides the default", () => {
		expect(act(ans({ asks_decision: 0.5 }))).toBe("escalate");
		expect(act(ans({ asks_decision: 0.49 }))).toBe("ignore");
		const t = { thresholds: { default: 0.5, asks_decision: 0.65 }, armedGraceMinutes: 360 };
		expect(act(ans({ asks_decision: 0.6 }), agent, t)).toBe("ignore");
		expect(act(ans({ asks_decision: 0.65 }), agent, t)).toBe("escalate");
	});
	test("the two known misses: a 'say go' ask escalates, a half-answer to a human nudges", () => {
		// Shapes of T01 and T02 in the evaluation (Jev's answers, rounded).
		expect(act(ans({ asks_decision: 0.98, work_finished: 0.4 }), { humanAsked: false, idleMinutes: 540 })).toBe(
			"escalate",
		);
		expect(act(ans({ partial_answer: 0.97, work_finished: 0.7 }), { humanAsked: true, idleMinutes: 566 })).toBe(
			"nudge",
		);
	});
});

describe("a user bank", () => {
	const q = (over: Partial<Question> & { id: string }): Question => ({
		ask: "Does it?",
		yes: "It does.",
		no: "It does not.",
		fires: "escalate",
		...over,
	});
	test("a minimal valid bank parses; precedence stays fixed whatever order the bank lists", () => {
		const bank = parseBank([q({ id: "done", fires: "settle" }), q({ id: "help" })]);
		expect(combine(bank, { done: 1, help: 1 }, agent, O).action).toBe("escalate");
	});
	test("anything malformed is refused with what is wrong, never ignored", () => {
		const bad: [unknown, string][] = [
			[[], "non-empty JSON array"],
			[{}, "non-empty JSON array"],
			[[null], "is not an object"],
			[[{ ...q({ id: "a" }), extra: 1 }], 'unknown key "extra"'],
			[[q({ id: "Bad-Id" })], "needs an id"],
			[[q({ id: "a" }), q({ id: "a" })], "two questions have the id a"],
			[[q({ id: "a", ask: " " })], 'needs a non-empty "ask"'],
			[[q({ id: "a", fires: "panic" as never })], "fires must be one of"],
			[[q({ id: "a", requires: ["sunny" as never] })], 'unknown fact "sunny"'],
			[[q({ id: "a", unless: ["nope"] })], 'unless "nope", which is not another question'],
			[[q({ id: "a", unless: ["a"] })], "which is not another question"],
			[[q({ id: "a", rules: ["("] })], "not a valid regular expression"],
			[[q({ id: "a", rules: ["@magic"] })], 'unknown rule builtin "@magic"'],
			[[q({ id: "a", fires: "settle" })], "no question fires escalate"],
			[
				[q({ id: "a" }), q({ id: "m", fires: "modifier" }), q({ id: "s", fires: "settle", unless: ["m"] })],
				"only a nudge",
			],
		];
		for (const [raw, msg] of bad) expect(() => parseBank(raw)).toThrow(msg);
	});
});
