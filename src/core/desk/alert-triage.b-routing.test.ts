/** B: routing (10). */
import { describe, expect, test } from "bun:test";
import { min, T0, triageRig } from "../../testing/alert-triage-fixtures.ts";
import { ALERT_TRIAGE, parseTriageConfig } from "./alert-triage-config.ts";
import { alertKey } from "./alert-triage-ids.ts";
import { obKey, seqKey } from "./alert-triage-obligation.ts";

const rules = [
	{ id: "swap-full", match: { family: "swap-full" }, outcome: "steward-task" },
	{ id: "tmp-fill", match: { family: "tmp-*" }, outcome: "steward-task" },
	{ id: "pass-tmp", match: { family: "tmp-filling" }, outcome: "pass-through" },
	{ id: "lit", match: { family: "a.*[x]" }, outcome: "steward-task" },
	{ id: "key-exp", match: { family: "secret-expiring" }, outcome: "human", right: "secrets" },
];

describe("B routing", () => {
	test("B1 exact rule", () => {
		const r = triageRig({
			triage: { enabled: true, rules: [rules[0]] },
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r.append({ source: "disk-guard", family: "swap-full" });
		r.settle(T0);
		expect(r.obligations()).toHaveLength(1);
		expect(r.stewardRows()).toHaveLength(1);
		const ak = alertKey("disk-guard", "swap-full");
		expect(r.store.items.get(ALERT_TRIAGE, obKey(ak))?.kind).toBe("obligation");
		expect(r.store.items.get(ALERT_TRIAGE, seqKey(ak))?.kind).toBe("seq");
	});

	test("B2 prefix, first match wins", () => {
		const r = triageRig({
			triage: {
				enabled: true,
				rules: [
					{ id: "pass-first", match: { family: "tmp-filling" }, outcome: "pass-through" },
					{ id: "tmp-fill", match: { family: "tmp-*" }, outcome: "steward-task" },
				],
			},
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r.append({ family: "tmp-filling", severity: "critical" });
		r.settle(T0);
		expect(r.obligations()).toHaveLength(0);
		expect(r.deskHeld().length + r.store.wakes.rows("all", "desk").length).toBeGreaterThan(0);
	});

	test("B3 literal match", () => {
		const r = triageRig({
			triage: { enabled: true, rules: [rules[3]] },
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r.append({ family: "a.*[x]" });
		r.settle(T0);
		expect(r.obligations()[0]?.rule).toBe("lit");
		r.append({ family: "abcx", at: min(1) });
		r.settle(min(1));
		expect(r.obligations().some((o) => o.event.family === "abcx")).toBe(true);
		expect(r.obligations().find((o) => o.event.family === "abcx")?.rule).toBe("default-critical");
	});

	test("B4 unmatched critical", () => {
		const r = triageRig({ triage: { enabled: true, rules: [] }, desk: { morningHour: 23, startAt: "beginning" } });
		r.append({ family: "unknown-crit" });
		r.settle(T0);
		expect(r.obligations()[0]?.rule).toBe("default-critical");
		expect(r.stewardRows()).toHaveLength(1);
	});

	test("B5 non-critical always passes through", () => {
		const r = triageRig({
			triage: {
				enabled: true,
				rules: [
					{ id: "w-steward", match: { family: "warn-fam" }, outcome: "steward-task" },
					{ id: "w-human", match: { family: "warn-fam" }, outcome: "human", right: "secrets" },
				],
			},
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r.append({ family: "warn-fam", severity: "warning" });
		r.settle(T0);
		r.append({ family: "warn-fam", severity: "warning", title: "again", at: min(1) });
		r.settle(min(1));
		const storePath = r.dir;
		const r2 = triageRig({
			store: r.store,
			triage: { enabled: true, rules: [] },
			desk: { morningHour: 23, startAt: "beginning" },
		});
		void storePath;
		void r2;
		expect(r.obligations()).toHaveLength(0);
		expect(r.stewardRows()).toHaveLength(0);
		expect(r.deskHeld().length).toBeGreaterThan(0);
	});

	test("B6 rule validation", () => {
		expect(parseTriageConfig({ enabled: true, rules: [{ id: "h", match: {}, outcome: "human" }] }).invalid).toBe(true);
		expect(
			parseTriageConfig({
				enabled: true,
				rules: [{ id: "s", match: {}, outcome: "steward-task", right: "secrets" }],
			}).invalid,
		).toBe(true);
		expect(
			parseTriageConfig({ enabled: true, rules: [{ id: "x", match: {}, outcome: "steward-task", extra: 1 }] }).invalid,
		).toBe(true);
		expect(
			parseTriageConfig({
				enabled: true,
				rules: [
					{ id: "a", match: {}, outcome: "steward-task" },
					{ id: "a", match: {}, outcome: "pass-through" },
				],
			}).invalid,
		).toBe(true);
		const typo = parseTriageConfig({ enabled: true, typo: 1 });
		expect(typo.invalid).toBe(true);
		expect(typo.enabled).toBe(true);
		expect(typo.rules).toEqual([]);
		const badMatch = parseTriageConfig({
			enabled: true,
			rules: [{ id: "bad", match: { source: 42 }, outcome: "pass-through" }],
		});
		expect(badMatch.invalid).toBe(true);
		expect(badMatch.enabled).toBe(true);
		expect(parseTriageConfig({ enabled: true, rules: "nope" }).invalid).toBe(true);
		const literalBad = parseTriageConfig({
			enabled: true,
			rules: [{ id: "literal", match: { source: "bad" }, outcome: "human", right: "secrets" }],
		});
		expect(literalBad.invalid).not.toBe(true);
		expect(literalBad.rules).toHaveLength(1);
		expect(literalBad.rules[0]?.match.source).toBe("bad");
		const literalBadFam = parseTriageConfig({
			enabled: true,
			rules: [{ id: "lit-fam", match: { family: "bad" }, outcome: "steward-task" }],
		});
		expect(literalBadFam.invalid).not.toBe(true);
		expect(literalBadFam.rules[0]?.match.family).toBe("bad");
	});

	test("B7 invalid config", () => {
		const r = triageRig({
			triage: { enabled: true, typo: 1 },
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r.append({ family: "x" });
		r.settle(T0);
		expect(r.alarms.has("alert-triage-config")).toBe(true);
		expect(r.stewardRows()).toHaveLength(1);
		const r2 = triageRig({
			triage: {
				enabled: true,
				rules: [{ id: "bad", match: { source: 42 }, outcome: "pass-through" }],
			},
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r2.append({ family: "other", source: "unrelated" });
		r2.settle(T0);
		expect(r2.alarms.has("alert-triage-config")).toBe(true);
		expect(r2.obligations()[0]?.rule).toBe("default-critical");
	});

	test("B8 human critical", () => {
		const r = triageRig({
			triage: { enabled: true, rules: [rules[4]] },
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r.append({ family: "secret-expiring" });
		r.settle(T0);
		expect(r.stewardRows()).toHaveLength(1);
		expect(r.stewardRows()[0]!.message).toContain('Needs Nathan\'s right "secrets"');
	});

	test("B9 critical ruled pass-through", () => {
		const r = triageRig({
			triage: {
				enabled: true,
				rules: [{ id: "pass", match: { family: "noise" }, outcome: "pass-through" }],
			},
			desk: { morningHour: 23, startAt: "beginning" },
		});
		r.append({ family: "noise", severity: "critical" });
		r.settle(T0);
		expect(r.obligations()).toHaveLength(0);
		expect(r.deskHeld().length).toBeGreaterThan(0);
		r.append({ family: "noise", severity: "critical", at: T0 - 7 * 3600_000, title: "old" });
		r.settle(min(1));
		expect(r.obligations().some((o) => o.reason === "stale-critical" || o.rule === "stale-critical")).toBe(true);
	});

	test("B10 flag-on non-critical parity", () => {
		const off = triageRig({ triage: { enabled: false }, desk: { morningHour: 23, startAt: "beginning" } });
		off.append({ family: "w1", severity: "warning" }, { family: "w2", severity: "info", at: min(1) });
		off.pass(min(1));
		const on = triageRig({ triage: { enabled: true, rules: [] }, desk: { morningHour: 23, startAt: "beginning" } });
		on.append({ family: "w1", severity: "warning" }, { family: "w2", severity: "info", at: min(1) });
		on.settle(min(1));
		expect(on.deskHeld().map((h) => h.message)).toEqual(off.deskHeld().map((h) => h.message));
	});
});
