/**
 * Rulings hygiene: recording is idempotent in the store, a ruling can expire (against a clock the test supplies) and can replace
 * others, and a ruling can leave force for a housekeeping reason that is kept with it.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { memStore } from "../testing/store.ts";
import { addInForce, expiresAt, expiredNow, inForceNow, isExpired, propose, readRulings, renderExpired, renderInForce, retireRuling, rulingsBriefText, rulingsText, confirmRuling, updateRulings, type Clock } from "./rulings.ts";
import { openStore } from "./sqlite-store.ts";

const at = (iso: string): Clock => () => Date.parse(iso);
const NOW = at("2026-11-13T12:00:00Z");

describe("recording is idempotent, in the store", () => {
	test("the same words and decision proposed twice give the held ruling back, and write one row", () => {
		const d = memStore();
		const a = propose(d, "Approve (Recommended)", "Gates like this are the Steward's");
		const b = propose(d, "Approve (Recommended)", "Gates like this are the Steward's");
		expect(b).toMatchObject({ id: a.id, duplicate: true });
		expect(a).not.toHaveProperty("duplicate");
		expect(readRulings(d)).toHaveLength(1);
	});
	test("case and runs of whitespace do not make words different", () => {
		const d = memStore();
		const a = addInForce(d, "Never  deploy on Fridays", "No production deploys\non Fridays.", "chat", "stated");
		const b = addInForce(d, "never deploy on fridays", " no production deploys on fridays. ", "chat", "stated");
		expect(b).toMatchObject({ id: a.id, duplicate: true });
		expect(readRulings(d)).toHaveLength(1);
	});
	test("different words, or the same words deciding something else, are two rulings", () => {
		const d = memStore();
		addInForce(d, "w", "one", "chat", "x");
		addInForce(d, "w", "two", "chat", "x");
		addInForce(d, "w2", "one", "chat", "x");
		expect(readRulings(d)).toHaveLength(3);
	});
	test("an in-force ruling said again changes nothing about it: no second row, no new history", () => {
		const d = memStore();
		const a = addInForce(d, "w", "d", "chat", "stated");
		const before = JSON.stringify(readRulings(d));
		const b = addInForce(d, "w", "d", "chat", "stated");
		expect(b.duplicate).toBe(true);
		expect(JSON.stringify(readRulings(d))).toBe(before);
		expect(a.id).toBe("R1");
	});
	test("a held proposal said again in chat goes in force instead of becoming a second ruling", () => {
		const d = memStore();
		const p = propose(d, "w", "d");
		const r = addInForce(d, "w", "d", "chat", "stated in chat");
		expect(r).toMatchObject({ id: p.id, duplicate: true, status: "in-force", confirmed: true });
		expect(readRulings(d)).toHaveLength(1);
		expect(readRulings(d)[0]!.history!.map((h) => h.what)).toEqual(["proposed by the Steward", "stated in chat (was not yet confirmed)"]);
	});
	test("an in-force card answer nobody confirmed is confirmed when the principal says it again", () => {
		const d = memStore();
		d.rulings.save({ id: "R1", date: "2026-11-01", words: "w", decides: "d", source: "card", status: "in-force", confirmed: false, history: [] });
		const r = addInForce(d, "w", "d", "chat", "stated in chat");
		expect(r).toMatchObject({ id: "R1", duplicate: true, confirmed: true });
		expect(readRulings(d)[0]).toMatchObject({ confirmed: true });
		expect(readRulings(d)[0]!.confirmedAt).toBeTruthy();
	});
	test("a retired ruling can be said again as a new one", () => {
		const d = memStore();
		const a = addInForce(d, "w", "d", "chat", "x");
		retireRuling(d, a.id, "retired");
		const b = addInForce(d, "w", "d", "chat", "x");
		expect(b.id).toBe("R2");
		expect(b.duplicate).toBeUndefined();
		expect(readRulings(d).map((r) => r.status)).toEqual(["retired", "in-force"]);
	});
	test("an expired ruling can be said again as a new one; a live one cannot", () => {
		const d = memStore();
		const a = addInForce(d, "w", "d", "chat", "x", undefined, { expires: "2026-11-14" }, NOW);
		expect(addInForce(d, "w", "d", "chat", "x", undefined, undefined, NOW).duplicate).toBe(true);
		const later = at("2026-11-15T00:00:00Z");
		const b = addInForce(d, "w", "d", "chat", "x", undefined, undefined, later);
		expect(b).toMatchObject({ id: "R2" });
		expect(a.id).toBe("R1");
	});
	test("a restatement adds an expiry the held ruling lacks, and keeps one it has", () => {
		const d = memStore();
		addInForce(d, "w", "d", "chat", "x");
		addInForce(d, "w", "d", "chat", "x", undefined, { expires: "2026-12-01", until: "the launch" }, NOW);
		expect(readRulings(d)[0]).toMatchObject({ expires: "2026-12-01", until: "the launch" });
		addInForce(d, "w", "d", "chat", "x", undefined, { expires: "2027-01-01" }, NOW);
		expect(readRulings(d)[0]!.expires).toBe("2026-12-01");
		expect(readRulings(d)[0]!.history!.map((h) => h.what)).toContain("expires and until added on a restatement");
	});
	test("two handles on one database file record the same ruling once: the second sees the first", () => {
		const dir = mkdtempSync(`${tmpdir()}/chamberlain-rulings-`);
		const one = openStore(`${dir}/c.db`);
		const two = openStore(`${dir}/c.db`);
		try {
			const a = propose(one, "w", "d");
			const b = addInForce(two, "w", "d", "chat", "x");
			const c = propose(one, "w", "d");
			expect([a.id, b.id, c.id]).toEqual(["R1", "R1", "R1"]);
			expect(readRulings(two)).toHaveLength(1);
		} finally { one.close(); two.close(); rmSync(dir, { recursive: true, force: true }); }
	});
	test("a recording that throws changes nothing", () => {
		const d = memStore();
		addInForce(d, "w", "d", "chat", "x");
		expect(() => addInForce(d, "w2", "d2", "chat", "x", undefined, { supersedes: ["R1", "R9"] })).toThrow("R9: no such ruling");
		expect(readRulings(d)).toHaveLength(1);
		expect(readRulings(d)[0]!.status).toBe("in-force");
	});
});

describe("expiry reads an injectable clock", () => {
	test("a date runs through the end of that day, UTC; a date-time ends at that moment", () => {
		expect(expiresAt("2026-11-13")).toBe(Date.parse("2026-11-13T23:59:59.999Z"));
		expect(expiresAt("2026-11-13T09:00:00Z")).toBe(Date.parse("2026-11-13T09:00:00Z"));
		expect(expiresAt("2026-11-13T09:00:00+02:00")).toBe(Date.parse("2026-11-13T07:00:00Z"));
		expect(isExpired({ expires: "2026-11-13" }, Date.parse("2026-11-13T23:59:59Z"))).toBe(false);
		expect(isExpired({ expires: "2026-11-13" }, Date.parse("2026-11-14T00:00:00Z"))).toBe(true);
		expect(isExpired({}, Date.parse("2999-01-01T00:00:00Z"))).toBe(false);
	});
	test("a value that is not a date, a date-time without a zone, and a date that does not exist are all unreadable", () => {
		for (const bad of ["tomorrow", "2026-13-01", "2026-02-30", "2026-11-13T09:00:00", "2026-11-13 09:00", "11/13/2026"]) expect(expiresAt(bad)).toBeNaN();
		// Unreadable counts as passed, so a bad stored value can never keep a ruling in force.
		expect(isExpired({ expires: "tomorrow" }, 0)).toBe(true);
	});
	test("a ruling leaves the in-force set when its time passes, and the record stays", () => {
		const d = memStore();
		addInForce(d, "stays", "Stays.", "chat", "x");
		addInForce(d, "goes", "Goes.", "chat", "x", undefined, { expires: "2026-11-20" }, NOW);
		expect(rulingsText(d, at("2026-11-20T23:00:00Z"))).toContain("R2");
		expect(rulingsText(d, at("2026-11-20T23:00:00Z"))).toContain("[expires 2026-11-20]");
		const after = at("2026-11-21T00:00:01Z");
		expect(rulingsText(d, after)).toContain("R1");
		expect(rulingsText(d, after)).not.toContain("R2");
		expect(inForceNow(readRulings(d), after()).map((r) => r.id)).toEqual(["R1"]);
		expect(expiredNow(readRulings(d), after()).map((r) => r.id)).toEqual(["R2"]);
		expect(readRulings(d)).toHaveLength(2);
		expect(readRulings(d)[1]).toMatchObject({ status: "in-force", expires: "2026-11-20" });
	});
	test("the hand-off's rulings section names the expired ones and says they are not in force", () => {
		const d = memStore();
		addInForce(d, "stays", "Stays.", "chat", "x");
		addInForce(d, "goes", "Goes.", "chat", "x", undefined, { expires: "2026-11-20" }, NOW);
		const brief = rulingsBriefText(d, at("2026-11-25T00:00:00Z"));
		expect(brief).toContain("- R1 (");
		expect(brief).not.toContain("- R2 (");
		expect(brief).toContain("Expired, NOT in force (do not act on them): R2 (expired 2026-11-20).");
		// The wakes carry only what is in force: no expired line there.
		expect(rulingsText(d, at("2026-11-25T00:00:00Z"))).not.toContain("Expired");
		// Nothing expired, nothing said.
		expect(renderExpired(readRulings(d), NOW())).toBe("");
		expect(rulingsBriefText(d, NOW)).toBe(rulingsText(d, NOW));
	});
	test("an until is shown with the ruling and never ends it", () => {
		const d = memStore();
		addInForce(d, "w", "d", "chat", "x", undefined, { until: "the V2 launch" }, NOW);
		expect(renderInForce(readRulings(d), Date.parse("2099-01-01"))).toContain("[until the V2 launch]");
	});
	test("an expiry that is unreadable, zoneless, impossible or already past is refused, and nothing is recorded", () => {
		const d = memStore();
		for (const expires of ["soon", "2026-11-14T09:00:00", "2026-02-30", "2026-11-12"]) {
			expect(() => propose(d, "w", "d", undefined, { expires }, NOW)).toThrow(/expires/);
			expect(() => addInForce(d, "w", "d", "chat", "x", undefined, { expires }, NOW)).toThrow(/expires/);
		}
		expect(readRulings(d)).toHaveLength(0);
	});
	test("an expired ruling cannot be confirmed", () => {
		const d = memStore();
		const p = propose(d, "w", "d", undefined, { expires: "2026-11-14" }, NOW);
		expect(() => confirmRuling(d, p.id, undefined, at("2026-11-15T00:00:00Z"))).toThrow(`${p.id} expired on 2026-11-14`);
		expect(confirmRuling(d, p.id, undefined, NOW)).toMatchObject({ status: "in-force", confirmed: true });
	});
});

describe("a ruling replaces others", () => {
	test("an in-force ruling that supersedes retires the older ones with a pointer and a reason", () => {
		const d = memStore();
		addInForce(d, "a", "old one", "chat", "x");
		addInForce(d, "b", "old two", "chat", "x");
		const r = addInForce(d, "c", "new", "chat", "x", undefined, { supersedes: ["R1", "R2"] }, NOW);
		expect(r.supersedes).toEqual(["R1", "R2"]);
		for (const id of ["R1", "R2"]) expect(readRulings(d).find((x) => x.id === id)).toMatchObject({ status: "retired", retiredHow: "superseded", supersededBy: r.id, retiredWhy: `replaced by ${r.id}` });
		expect(rulingsText(d, NOW)).not.toContain("- R1 ");
	});
	test("a proposal that supersedes retires nothing until the principal confirms it", () => {
		const d = memStore();
		addInForce(d, "a", "old", "chat", "x");
		const p = propose(d, "b", "new", undefined, { supersedes: ["R1"] });
		expect(readRulings(d)[0]!.status).toBe("in-force");
		confirmRuling(d, p.id);
		expect(readRulings(d)[0]).toMatchObject({ status: "retired", retiredHow: "superseded", supersededBy: p.id });
	});
	test("saying it again retires what it supersedes, and a ruling already retired is left as it is", () => {
		const d = memStore();
		addInForce(d, "a", "old", "chat", "x");
		retireRuling(d, "R1", "retired");
		const r = addInForce(d, "b", "new", "chat", "x", undefined, { supersedes: ["R1"] });
		expect(readRulings(d)[0]).toMatchObject({ retiredHow: "retired" });
		expect(readRulings(d)[0]).not.toHaveProperty("supersededBy");
		addInForce(d, "a2", "old2", "chat", "x");
		const again = addInForce(d, "b", "new", "chat", "x", undefined, { supersedes: ["R3"] });
		expect(again).toMatchObject({ id: r.id, duplicate: true });
		expect(readRulings(d).find((x) => x.id === "R3")).toMatchObject({ status: "retired", supersededBy: r.id });
	});
	test("a proposal repeated with supersedes keeps them: confirming it retires what the repeat named", () => {
		const d = memStore();
		addInForce(d, "a", "old one", "chat", "x");
		addInForce(d, "a2", "old two", "chat", "x");
		const p = propose(d, "b", "new", undefined, { supersedes: ["R2"] }, NOW);
		const again = propose(d, "b", "new", undefined, { supersedes: ["R1", "R2"] }, NOW);
		expect(again).toMatchObject({ id: p.id, duplicate: true, supersedes: ["R2", "R1"], supersedesAdded: ["R1"] });
		expect(readRulings(d).find((x) => x.id === p.id)!.supersedes).toEqual(["R2", "R1"]);
		// Nothing retires before the confirm; both do on it.
		expect(readRulings(d).filter((x) => x.status === "in-force").map((x) => x.id)).toEqual(["R1", "R2"]);
		confirmRuling(d, p.id, undefined, NOW);
		for (const id of ["R1", "R2"]) expect(readRulings(d).find((x) => x.id === id)).toMatchObject({ status: "retired", retiredHow: "superseded", supersededBy: p.id });
	});
	test("a repeat of an in-force ruling naming supersedes retires the newly named ones in the same write", () => {
		const d = memStore();
		addInForce(d, "a", "old", "chat", "x");
		const r = addInForce(d, "b", "new", "chat", "x");
		const again = propose(d, "b", "new", undefined, { supersedes: ["R1"] }, NOW);
		expect(again).toMatchObject({ id: r.id, duplicate: true, supersedes: ["R1"], supersedesAdded: ["R1"] });
		expect(readRulings(d)[0]).toMatchObject({ status: "retired", retiredHow: "superseded", supersededBy: r.id });
		expect(readRulings(d).find((x) => x.id === r.id)!.supersedes).toEqual(["R1"]);
		// A missing id changes nothing, even on a repeat.
		expect(() => propose(d, "b", "new", undefined, { supersedes: ["R9"] }, NOW)).toThrow("supersedes R9: no such ruling");
		expect(readRulings(d).find((x) => x.id === r.id)!.supersedes).toEqual(["R1"]);
	});
	test("a repeat that names nothing new reports nothing added", () => {
		const d = memStore();
		addInForce(d, "a", "old", "chat", "x");
		propose(d, "b", "new", undefined, { supersedes: ["R1"] }, NOW);
		expect(propose(d, "b", "new", undefined, { supersedes: ["R1"] }, NOW)).not.toHaveProperty("supersedesAdded");
	});
	test("an id that is not a ruling, or not an id, is refused", () => {
		const d = memStore();
		addInForce(d, "a", "old", "chat", "x");
		expect(() => propose(d, "b", "new", undefined, { supersedes: ["R7"] })).toThrow("supersedes R7: no such ruling");
		expect(() => propose(d, "b", "new", undefined, { supersedes: ["old"] })).toThrow("supersedes takes ruling ids");
		expect(readRulings(d)).toHaveLength(1);
	});
});

describe("leaving force for a housekeeping reason", () => {
	const seeded = () => { const d = memStore(); addInForce(d, "a", "one", "chat", "x"); addInForce(d, "b", "two", "chat", "x"); return d; };
	test("every reason is kept with the ruling, with its reason and the ruling that replaces it", () => {
		const d = seeded();
		retireRuling(d, "R1", "duplicate", "same rule, recorded twice", "R2");
		expect(readRulings(d)[0]).toMatchObject({ status: "retired", retiredHow: "duplicate", retiredWhy: "same rule, recorded twice", supersededBy: "R2" });
		const e = seeded();
		retireRuling(e, "R1", "expired", "the launch is over");
		retireRuling(e, "R2", "repeat", "decision-rights.md already says this");
		expect(readRulings(e).map((r) => [r.retiredHow, r.retiredWhy])).toEqual([["expired", "the launch is over"], ["repeat", "decision-rights.md already says this"]]);
		const f = seeded();
		retireRuling(f, "R1", "superseded", "folded into R2", "R2");
		expect(readRulings(f)[0]).toMatchObject({ retiredHow: "superseded", supersededBy: "R2" });
	});
	test("a housekeeping reason needs a why, and a duplicate needs the ruling it duplicates, which must be live and another one", () => {
		const d = seeded();
		expect(() => retireRuling(d, "R1", "expired")).toThrow("retiring R1 as expired needs a reason");
		expect(() => retireRuling(d, "R1", "duplicate", "twice")).toThrow("needs the ruling that replaces it");
		expect(() => retireRuling(d, "R1", "duplicate", "twice", "R1")).toThrow("R1 is not another ruling that is still live");
		expect(() => retireRuling(d, "R1", "duplicate", "twice", "R9")).toThrow("R9 is not another ruling that is still live");
		retireRuling(d, "R2", "retired");
		expect(() => retireRuling(d, "R1", "duplicate", "twice", "R2")).toThrow("R2 is not another ruling that is still live");
		expect(readRulings(d)[0]!.status).toBe("in-force");
	});
	test("a ruling already retired keeps its first reason", () => {
		const d = seeded();
		retireRuling(d, "R1", "expired", "over");
		retireRuling(d, "R1", "duplicate", "again", "R2");
		expect(readRulings(d)[0]).toMatchObject({ retiredHow: "expired", retiredWhy: "over" });
	});
	test("the page's own two reasons still need no why", () => {
		const d = seeded();
		retireRuling(d, "R1", "retired");
		retireRuling(d, "R2", "only this once");
		expect(readRulings(d).map((r) => r.retiredHow)).toEqual(["retired", "only this once"]);
	});
});

describe("the new fields survive the table", () => {
	test("every field of a ruling is read back as it was saved", () => {
		const d = memStore();
		d.rulings.save({
			id: "R5", date: "2026-11-13", words: "w", decides: "d", source: "card", status: "retired", confirmed: true, confirmedAt: "2026-11-13T10:00:00.000Z", retiredAt: "2026-11-13T11:00:00.000Z",
			retiredHow: "superseded", retiredWhy: "replaced by R6", supersededBy: "R6", supersedes: ["R1", "R2"], expires: "2026-12-01T09:00:00Z", until: "the launch", item: "Q-abc12", history: [{ t: "t", what: "x" }],
		});
		expect(readRulings(d)[0]).toEqual({
			id: "R5", date: "2026-11-13", words: "w", decides: "d", source: "card", status: "retired", confirmed: true, confirmedAt: "2026-11-13T10:00:00.000Z", retiredAt: "2026-11-13T11:00:00.000Z",
			retiredHow: "superseded", retiredWhy: "replaced by R6", supersededBy: "R6", supersedes: ["R1", "R2"], expires: "2026-12-01T09:00:00Z", until: "the launch", item: "Q-abc12", history: [{ t: "t", what: "x" }],
		});
	});
	test("a ruling with none of them reads back with none of them", () => {
		const d = memStore();
		addInForce(d, "w", "d", "chat", "x");
		const r = readRulings(d)[0]!;
		for (const k of ["retiredWhy", "supersededBy", "supersedes", "expires", "until"]) expect(r).not.toHaveProperty(k);
	});
	test("an update that changes only a new field is saved", () => {
		const d = memStore();
		addInForce(d, "w", "d", "chat", "x");
		updateRulings(d, (list) => { list[0]!.expires = "2026-12-01"; });
		expect(readRulings(d)[0]!.expires).toBe("2026-12-01");
	});
	test("the table refuses a retiredHow it does not know", () => {
		const d = memStore();
		expect(() => d.rulings.save({ id: "R1", date: "d", words: "w", decides: "d", source: "chat", status: "retired", confirmed: true, retiredHow: "bogus" as never, history: [] })).toThrow();
	});
});
