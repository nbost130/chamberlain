/**
 * Rulings hygiene: recording is idempotent in the store, a ruling can expire (against a clock the test supplies) and can replace
 * others, and a ruling can leave force for a housekeeping reason that is kept with it.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { memStore } from "../testing/store.ts";
import { addInForce, type Clock, propose, readRulings, updateRulings } from "./rulings.ts";
import { confirmRuling, retireRuling } from "./rulings-change.ts";
import { expiresAt, isExpired } from "./rulings-expiry.ts";
import { expiredNow, inForceNow, renderExpired, renderInForce, rulingsBriefText, rulingsText } from "./rulings-read.ts";
import { openStore } from "./sqlite-store.ts";

const at =
	(iso: string): Clock =>
	() =>
		Date.parse(iso);
const NOW = at("2026-11-13T12:00:00Z");

describe("recording is idempotent, in the store", () => {
	test("the same words and decision proposed twice give the held ruling back, and write one row", () => {
		const d = memStore();
		const a = propose(d, { words: "Approve (Recommended)", decides: "Gates like this are the Steward's" });
		const b = propose(d, { words: "Approve (Recommended)", decides: "Gates like this are the Steward's" });
		expect(b).toMatchObject({ id: a.id, duplicate: true });
		expect(a).not.toHaveProperty("duplicate");
		expect(readRulings(d)).toHaveLength(1);
	});
	test("case and runs of whitespace do not make words different", () => {
		const d = memStore();
		const a = addInForce(d, {
			words: "Never  deploy on Fridays",
			decides: "No production deploys\non Fridays.",
			source: "chat",
			how: "stated",
		});
		const b = addInForce(d, {
			words: "never deploy on fridays",
			decides: " no production deploys on fridays. ",
			source: "chat",
			how: "stated",
		});
		expect(b).toMatchObject({ id: a.id, duplicate: true });
		expect(readRulings(d)).toHaveLength(1);
	});
	test("different words, or the same words deciding something else, are two rulings", () => {
		const d = memStore();
		addInForce(d, { words: "w", decides: "one", source: "chat", how: "x" });
		addInForce(d, { words: "w", decides: "two", source: "chat", how: "x" });
		addInForce(d, { words: "w2", decides: "one", source: "chat", how: "x" });
		expect(readRulings(d)).toHaveLength(3);
	});
	test("an in-force ruling said again changes nothing about it: no second row, no new history", () => {
		const d = memStore();
		const a = addInForce(d, { words: "w", decides: "d", source: "chat", how: "stated" });
		const before = JSON.stringify(readRulings(d));
		const b = addInForce(d, { words: "w", decides: "d", source: "chat", how: "stated" });
		expect(b.duplicate).toBe(true);
		expect(JSON.stringify(readRulings(d))).toBe(before);
		expect(a.id).toBe("R1");
	});
	test("a held proposal said again in chat goes in force instead of becoming a second ruling", () => {
		const d = memStore();
		const p = propose(d, { words: "w", decides: "d" });
		const r = addInForce(d, { words: "w", decides: "d", source: "chat", how: "stated in chat" });
		expect(r).toMatchObject({ id: p.id, duplicate: true, status: "in-force", confirmed: true });
		expect(readRulings(d)).toHaveLength(1);
		expect(readRulings(d)[0]!.history!.map((h) => h.what)).toEqual([
			"proposed by the Steward",
			"stated in chat (was not yet confirmed)",
		]);
	});
	test("an in-force card answer nobody confirmed is confirmed when the principal says it again", () => {
		const d = memStore();
		d.rulings.save({
			id: "R1",
			date: "2026-11-01",
			words: "w",
			decides: "d",
			source: "card",
			status: "in-force",
			confirmed: false,
			history: [],
		});
		const r = addInForce(d, { words: "w", decides: "d", source: "chat", how: "stated in chat" });
		expect(r).toMatchObject({ id: "R1", duplicate: true, confirmed: true });
		expect(readRulings(d)[0]).toMatchObject({ confirmed: true });
		expect(readRulings(d)[0]!.confirmedAt).toBeTruthy();
	});
	test("a retired ruling can be said again as a new one", () => {
		const d = memStore();
		const a = addInForce(d, { words: "w", decides: "d", source: "chat", how: "x" });
		retireRuling(d, a.id, { how: "retired" });
		const b = addInForce(d, { words: "w", decides: "d", source: "chat", how: "x" });
		expect(b.id).toBe("R2");
		expect(b.duplicate).toBeUndefined();
		expect(readRulings(d).map((r) => r.status)).toEqual(["retired", "in-force"]);
	});
	test("an expired ruling can be said again as a new one; a live one cannot", () => {
		const d = memStore();
		const a = addInForce(
			d,
			{ words: "w", decides: "d", source: "chat", how: "x", opts: { expires: "2026-11-14" } },
			NOW,
		);
		expect(addInForce(d, { words: "w", decides: "d", source: "chat", how: "x" }, NOW).duplicate).toBe(true);
		const later = at("2026-11-15T00:00:00Z");
		const b = addInForce(d, { words: "w", decides: "d", source: "chat", how: "x" }, later);
		expect(b).toMatchObject({ id: "R2" });
		expect(a.id).toBe("R1");
	});
	test("a restatement adds an expiry the held ruling lacks, and keeps one it has", () => {
		const d = memStore();
		addInForce(d, { words: "w", decides: "d", source: "chat", how: "x" });
		addInForce(
			d,
			{ words: "w", decides: "d", source: "chat", how: "x", opts: { expires: "2026-12-01", until: "the launch" } },
			NOW,
		);
		expect(readRulings(d)[0]).toMatchObject({ expires: "2026-12-01", until: "the launch" });
		addInForce(d, { words: "w", decides: "d", source: "chat", how: "x", opts: { expires: "2027-01-01" } }, NOW);
		expect(readRulings(d)[0]!.expires).toBe("2026-12-01");
		expect(readRulings(d)[0]!.history!.map((h) => h.what)).toContain("expires and until added on a restatement");
	});
	test("two handles on one database file record the same ruling once: the second sees the first", () => {
		const dir = mkdtempSync(`${tmpdir()}/chamberlain-rulings-`);
		const one = openStore(`${dir}/c.db`);
		const two = openStore(`${dir}/c.db`);
		try {
			const a = propose(one, { words: "w", decides: "d" });
			const b = addInForce(two, { words: "w", decides: "d", source: "chat", how: "x" });
			const c = propose(one, { words: "w", decides: "d" });
			expect([a.id, b.id, c.id]).toEqual(["R1", "R1", "R1"]);
			expect(readRulings(two)).toHaveLength(1);
		} finally {
			one.close();
			two.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	test("a recording that throws changes nothing", () => {
		const d = memStore();
		addInForce(d, { words: "w", decides: "d", source: "chat", how: "x" });
		expect(() =>
			addInForce(d, { words: "w2", decides: "d2", source: "chat", how: "x", opts: { supersedes: ["R1", "R9"] } }),
		).toThrow("R9: no such ruling");
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
		for (const bad of ["tomorrow", "2026-13-01", "2026-02-30", "2026-11-13T09:00:00", "2026-11-13 09:00", "11/13/2026"])
			expect(expiresAt(bad)).toBeNaN();
		// Unreadable counts as passed, so a bad stored value can never keep a ruling in force.
		expect(isExpired({ expires: "tomorrow" }, 0)).toBe(true);
	});
	test("a date or date-time that does not exist is unreadable, never rolled into another day", () => {
		for (const bad of [
			"2027-02-30T09:00:00Z",
			"2027-02-29T09:00:00Z",
			"2027-02-29",
			"2026-13-01T09:00:00Z",
			"2026-00-10T09:00:00Z",
			"2026-11-13T24:00:00Z",
			"2026-11-13T09:60:00Z",
			"2026-11-13T09:00:60Z",
			"2026-11-31T09:00:00+02:00",
			"2026-11-13T09:00:00+24:00",
			"2026-11-13T09:00:00+02:60",
		])
			expect(expiresAt(bad)).toBeNaN();
		expect(expiresAt("2028-02-29T09:00:00Z")).toBe(Date.parse("2028-02-29T09:00:00Z"));
		expect(expiresAt("2028-02-29")).toBe(Date.parse("2028-02-29T23:59:59.999Z"));
		expect(expiresAt("2026-11-13T09:00:00.250-05:30")).toBe(Date.parse("2026-11-13T09:00:00.250-05:30"));
		expect(expiresAt("2026-11-13T09:00+01:00")).toBe(Date.parse("2026-11-13T08:00:00Z"));
	});
	test("recording refuses an expiry that does not exist, with a clear error, and writes nothing", () => {
		const d = memStore();
		for (const expires of [
			"2027-02-30T09:00:00Z",
			"2027-02-29T09:00:00Z",
			"2026-13-01T09:00:00Z",
			"2026-11-13T24:00:00Z",
		]) {
			expect(() => propose(d, { words: "w", decides: "d", opts: { expires } }, NOW)).toThrow(
				`expires "${expires}" is not a real date and time`,
			);
			expect(() =>
				addInForce(d, { words: "w", decides: "d", source: "chat", how: "x", opts: { expires } }, NOW),
			).toThrow(`expires "${expires}" is not a real date and time`);
		}
		expect(readRulings(d)).toHaveLength(0);
		expect(propose(d, { words: "w", decides: "d", opts: { expires: "2028-02-29T09:00:00Z" } }, NOW).expires).toBe(
			"2028-02-29T09:00:00Z",
		);
	});
	test("a ruling leaves the in-force set when its time passes, and the record stays", () => {
		const d = memStore();
		addInForce(d, { words: "stays", decides: "Stays.", source: "chat", how: "x" });
		addInForce(d, { words: "goes", decides: "Goes.", source: "chat", how: "x", opts: { expires: "2026-11-20" } }, NOW);
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
		addInForce(d, { words: "stays", decides: "Stays.", source: "chat", how: "x" });
		addInForce(d, { words: "goes", decides: "Goes.", source: "chat", how: "x", opts: { expires: "2026-11-20" } }, NOW);
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
		addInForce(d, { words: "w", decides: "d", source: "chat", how: "x", opts: { until: "the V2 launch" } }, NOW);
		expect(renderInForce(readRulings(d), Date.parse("2099-01-01"))).toContain("[until the V2 launch]");
	});
	test("an expiry that is unreadable, zoneless, impossible or already past is refused, and nothing is recorded", () => {
		const d = memStore();
		for (const expires of ["soon", "2026-11-14T09:00:00", "2026-02-30", "2026-11-12"]) {
			expect(() => propose(d, { words: "w", decides: "d", opts: { expires } }, NOW)).toThrow(/expires/);
			expect(() =>
				addInForce(d, { words: "w", decides: "d", source: "chat", how: "x", opts: { expires } }, NOW),
			).toThrow(/expires/);
		}
		expect(readRulings(d)).toHaveLength(0);
	});
	test("an expired ruling cannot be confirmed", () => {
		const d = memStore();
		const p = propose(d, { words: "w", decides: "d", opts: { expires: "2026-11-14" } }, NOW);
		expect(() => confirmRuling(d, p.id, undefined, at("2026-11-15T00:00:00Z"))).toThrow(
			`${p.id} expired on 2026-11-14`,
		);
		expect(confirmRuling(d, p.id, undefined, NOW)).toMatchObject({ status: "in-force", confirmed: true });
	});
});

describe("a ruling replaces others", () => {
	test("an in-force ruling that supersedes retires the older ones with a pointer and a reason", () => {
		const d = memStore();
		addInForce(d, { words: "a", decides: "old one", source: "chat", how: "x" });
		addInForce(d, { words: "b", decides: "old two", source: "chat", how: "x" });
		const r = addInForce(
			d,
			{ words: "c", decides: "new", source: "chat", how: "x", opts: { supersedes: ["R1", "R2"] } },
			NOW,
		);
		expect(r.supersedes).toEqual(["R1", "R2"]);
		for (const id of ["R1", "R2"])
			expect(readRulings(d).find((x) => x.id === id)).toMatchObject({
				status: "retired",
				retiredHow: "superseded",
				supersededBy: r.id,
				retiredWhy: `replaced by ${r.id}`,
			});
		expect(rulingsText(d, NOW)).not.toContain("- R1 ");
	});
	test("a proposal that supersedes retires nothing until the principal confirms it", () => {
		const d = memStore();
		addInForce(d, { words: "a", decides: "old", source: "chat", how: "x" });
		const p = propose(d, { words: "b", decides: "new", opts: { supersedes: ["R1"] } });
		expect(readRulings(d)[0]!.status).toBe("in-force");
		confirmRuling(d, p.id);
		expect(readRulings(d)[0]).toMatchObject({ status: "retired", retiredHow: "superseded", supersededBy: p.id });
	});
	test("saying it again retires what it supersedes, and a ruling already retired is left as it is", () => {
		const d = memStore();
		addInForce(d, { words: "a", decides: "old", source: "chat", how: "x" });
		retireRuling(d, "R1", { how: "retired" });
		const r = addInForce(d, { words: "b", decides: "new", source: "chat", how: "x", opts: { supersedes: ["R1"] } });
		expect(readRulings(d)[0]).toMatchObject({ retiredHow: "retired" });
		expect(readRulings(d)[0]).not.toHaveProperty("supersededBy");
		addInForce(d, { words: "a2", decides: "old2", source: "chat", how: "x" });
		const again = addInForce(d, { words: "b", decides: "new", source: "chat", how: "x", opts: { supersedes: ["R3"] } });
		expect(again).toMatchObject({ id: r.id, duplicate: true });
		expect(readRulings(d).find((x) => x.id === "R3")).toMatchObject({ status: "retired", supersededBy: r.id });
	});
	test("a proposal repeated with supersedes keeps them: confirming it retires what the repeat named", () => {
		const d = memStore();
		addInForce(d, { words: "a", decides: "old one", source: "chat", how: "x" });
		addInForce(d, { words: "a2", decides: "old two", source: "chat", how: "x" });
		const p = propose(d, { words: "b", decides: "new", opts: { supersedes: ["R2"] } }, NOW);
		const again = propose(d, { words: "b", decides: "new", opts: { supersedes: ["R1", "R2"] } }, NOW);
		expect(again).toMatchObject({ id: p.id, duplicate: true, supersedes: ["R2", "R1"], supersedesAdded: ["R1"] });
		expect(readRulings(d).find((x) => x.id === p.id)!.supersedes).toEqual(["R2", "R1"]);
		// Nothing retires before the confirm; both do on it.
		expect(
			readRulings(d)
				.filter((x) => x.status === "in-force")
				.map((x) => x.id),
		).toEqual(["R1", "R2"]);
		confirmRuling(d, p.id, undefined, NOW);
		for (const id of ["R1", "R2"])
			expect(readRulings(d).find((x) => x.id === id)).toMatchObject({
				status: "retired",
				retiredHow: "superseded",
				supersededBy: p.id,
			});
	});
	test("a proposal repeating a ruling already in force adds no supersedes and retires nothing", () => {
		const d = memStore();
		addInForce(d, { words: "a", decides: "old", source: "chat", how: "x" });
		const r = addInForce(d, { words: "b", decides: "new", source: "chat", how: "x" });
		const before = JSON.stringify(readRulings(d));
		const again = propose(
			d,
			{ words: "b", decides: "new", opts: { supersedes: ["R1"], expires: "2027-01-01", until: "launch" } },
			NOW,
		);
		expect(again).toMatchObject({
			id: r.id,
			status: "in-force",
			duplicate: true,
			alreadyInForce: true,
			supersedesNotAdded: ["R1"],
		});
		expect(again).not.toHaveProperty("supersedesAdded");
		expect(JSON.stringify(readRulings(d))).toBe(before);
		expect(readRulings(d)[0]).toMatchObject({ status: "in-force" });
		expect(readRulings(d).find((x) => x.id === r.id)).not.toHaveProperty("supersedes");
		// A missing id is still an error, even on a repeat.
		expect(() => propose(d, { words: "b", decides: "new", opts: { supersedes: ["R9"] } }, NOW)).toThrow(
			"supersedes R9: no such ruling",
		);
	});
	test("the principal's own repeat of an in-force ruling naming supersedes retires the newly named ones in the same write", () => {
		const d = memStore();
		addInForce(d, { words: "a", decides: "old", source: "chat", how: "x" });
		const r = addInForce(d, { words: "b", decides: "new", source: "chat", how: "x" });
		const again = addInForce(
			d,
			{ words: "b", decides: "new", source: "chat", how: "x", opts: { supersedes: ["R1"] } },
			NOW,
		);
		expect(again).toMatchObject({ id: r.id, duplicate: true, supersedes: ["R1"], supersedesAdded: ["R1"] });
		expect(again).not.toHaveProperty("alreadyInForce");
		expect(readRulings(d)[0]).toMatchObject({ status: "retired", retiredHow: "superseded", supersededBy: r.id });
		expect(() =>
			addInForce(d, { words: "b", decides: "new", source: "chat", how: "x", opts: { supersedes: ["R9"] } }, NOW),
		).toThrow("supersedes R9: no such ruling");
		expect(readRulings(d).find((x) => x.id === r.id)!.supersedes).toEqual(["R1"]);
	});
	test("a repeat that names nothing new reports nothing added", () => {
		const d = memStore();
		addInForce(d, { words: "a", decides: "old", source: "chat", how: "x" });
		propose(d, { words: "b", decides: "new", opts: { supersedes: ["R1"] } }, NOW);
		expect(propose(d, { words: "b", decides: "new", opts: { supersedes: ["R1"] } }, NOW)).not.toHaveProperty(
			"supersedesAdded",
		);
	});
	test("an id that is not a ruling, or not an id, is refused", () => {
		const d = memStore();
		addInForce(d, { words: "a", decides: "old", source: "chat", how: "x" });
		expect(() => propose(d, { words: "b", decides: "new", opts: { supersedes: ["R7"] } })).toThrow(
			"supersedes R7: no such ruling",
		);
		expect(() => propose(d, { words: "b", decides: "new", opts: { supersedes: ["old"] } })).toThrow(
			"supersedes takes ruling ids",
		);
		expect(readRulings(d)).toHaveLength(1);
	});
});

describe("the supersede graph has no cycle", () => {
	const ids = (d: ReturnType<typeof memStore>) =>
		readRulings(d).map((r) => `${r.id}:${r.status}:${(r.supersedes ?? []).join("+")}`);
	test("a 2-cycle is refused: propose R1, propose R2 superseding R1, repeat R1 superseding R2", () => {
		const d = memStore();
		propose(d, { words: "a", decides: "one" }, NOW);
		propose(d, { words: "b", decides: "two", opts: { supersedes: ["R1"] } }, NOW);
		const before = ids(d);
		expect(() => propose(d, { words: "a", decides: "one", opts: { supersedes: ["R2"] } }, NOW)).toThrow(
			"would make a supersede cycle: R1 → R2 → R1",
		);
		// The principal's word cannot make one either, and neither attempt wrote anything.
		expect(() =>
			addInForce(d, { words: "a", decides: "one", source: "chat", how: "x", opts: { supersedes: ["R2"] } }, NOW),
		).toThrow("supersede cycle: R1 → R2 → R1");
		expect(ids(d)).toEqual(before);
		expect(readRulings(d)[0]).toMatchObject({ status: "proposed" });
	});
	test("a 3-cycle is refused, counting in-force and proposed edges", () => {
		const d = memStore();
		addInForce(d, { words: "a", decides: "one", source: "chat", how: "x" }, NOW);
		propose(d, { words: "b", decides: "two", opts: { supersedes: ["R1"] } }, NOW);
		propose(d, { words: "c", decides: "three", opts: { supersedes: ["R2"] } }, NOW);
		const before = ids(d);
		expect(() =>
			addInForce(d, { words: "a", decides: "one", source: "chat", how: "x", opts: { supersedes: ["R3"] } }, NOW),
		).toThrow("supersede cycle: R1 → R3 → R2 → R1");
		expect(ids(d)).toEqual(before);
		expect(readRulings(d).map((r) => r.status)).toEqual(["in-force", "proposed", "proposed"]);
	});
	test("a ruling cannot supersede itself", () => {
		const d = memStore();
		propose(d, { words: "a", decides: "one" }, NOW);
		addInForce(d, { words: "b", decides: "two", source: "chat", how: "x" }, NOW);
		expect(() => propose(d, { words: "a", decides: "one", opts: { supersedes: ["R1"] } }, NOW)).toThrow(
			"supersedes R1: a ruling cannot supersede itself",
		);
		expect(() =>
			addInForce(d, { words: "b", decides: "two", source: "chat", how: "x", opts: { supersedes: ["R2"] } }, NOW),
		).toThrow("supersedes R2: a ruling cannot supersede itself");
		expect(readRulings(d).every((r) => !r.supersedes)).toBe(true);
	});
	test("confirming re-checks the graph: a cycle already stored is refused, and nothing is retired", () => {
		const d = memStore();
		propose(d, { words: "a", decides: "one" }, NOW);
		propose(d, { words: "b", decides: "two", opts: { supersedes: ["R1"] } }, NOW);
		// A cycle that came in by another road (an imported ledger), written straight to the store.
		updateRulings(d, (list) => {
			list[0]!.supersedes = ["R2"];
		});
		expect(() => confirmRuling(d, "R2", undefined, NOW)).toThrow(
			"confirming R2 would put a supersede cycle in force: R1 → R2 → R1",
		);
		expect(readRulings(d).map((r) => r.status)).toEqual(["proposed", "proposed"]);
		updateRulings(d, (list) => {
			list[0]!.supersedes = ["R1"];
		});
		expect(() => confirmRuling(d, "R1", undefined, NOW)).toThrow("supersede cycle in force: R1 → R1");
	});
	test("an acyclic chain is accepted and confirms in order", () => {
		const d = memStore();
		addInForce(d, { words: "a", decides: "one", source: "chat", how: "x" }, NOW);
		propose(d, { words: "b", decides: "two", opts: { supersedes: ["R1"] } }, NOW);
		propose(d, { words: "c", decides: "three", opts: { supersedes: ["R2", "R1"] } }, NOW);
		confirmRuling(d, "R3", undefined, NOW);
		expect(readRulings(d).map((r) => r.status)).toEqual(["retired", "retired", "in-force"]);
	});
});

describe("leaving force for a housekeeping reason", () => {
	const seeded = () => {
		const d = memStore();
		addInForce(d, { words: "a", decides: "one", source: "chat", how: "x" });
		addInForce(d, { words: "b", decides: "two", source: "chat", how: "x" });
		return d;
	};
	test("every reason is kept with the ruling, with its reason and the ruling that replaces it", () => {
		const d = seeded();
		retireRuling(d, "R1", { how: "duplicate", why: "same rule, recorded twice", by: "R2" });
		expect(readRulings(d)[0]).toMatchObject({
			status: "retired",
			retiredHow: "duplicate",
			retiredWhy: "same rule, recorded twice",
			supersededBy: "R2",
		});
		const e = seeded();
		retireRuling(e, "R1", { how: "expired", why: "the launch is over" });
		retireRuling(e, "R2", { how: "repeat", why: "decision-rights.md already says this" });
		expect(readRulings(e).map((r) => [r.retiredHow, r.retiredWhy])).toEqual([
			["expired", "the launch is over"],
			["repeat", "decision-rights.md already says this"],
		]);
		const f = seeded();
		retireRuling(f, "R1", { how: "superseded", why: "folded into R2", by: "R2" });
		expect(readRulings(f)[0]).toMatchObject({ retiredHow: "superseded", supersededBy: "R2" });
	});
	test("a housekeeping reason needs a why, and a duplicate needs the ruling it duplicates, which must be live and another one", () => {
		const d = seeded();
		expect(() => retireRuling(d, "R1", { how: "expired" })).toThrow("retiring R1 as expired needs a reason");
		expect(() => retireRuling(d, "R1", { how: "duplicate", why: "twice" })).toThrow(
			"needs the ruling that replaces it",
		);
		expect(() => retireRuling(d, "R1", { how: "duplicate", why: "twice", by: "R1" })).toThrow(
			"R1 is not another ruling that is still live",
		);
		expect(() => retireRuling(d, "R1", { how: "duplicate", why: "twice", by: "R9" })).toThrow(
			"R9 is not another ruling that is still live",
		);
		retireRuling(d, "R2", { how: "retired" });
		expect(() => retireRuling(d, "R1", { how: "duplicate", why: "twice", by: "R2" })).toThrow(
			"R2 is not another ruling that is still live",
		);
		expect(readRulings(d)[0]!.status).toBe("in-force");
	});
	test("a ruling already retired keeps its first reason", () => {
		const d = seeded();
		retireRuling(d, "R1", { how: "expired", why: "over" });
		retireRuling(d, "R1", { how: "duplicate", why: "again", by: "R2" });
		expect(readRulings(d)[0]).toMatchObject({ retiredHow: "expired", retiredWhy: "over" });
	});
	test("the page's own two reasons still need no why", () => {
		const d = seeded();
		retireRuling(d, "R1", { how: "retired" });
		retireRuling(d, "R2", { how: "only this once" });
		expect(readRulings(d).map((r) => r.retiredHow)).toEqual(["retired", "only this once"]);
	});
});

describe("the new fields survive the table", () => {
	test("every field of a ruling is read back as it was saved", () => {
		const d = memStore();
		d.rulings.save({
			id: "R5",
			date: "2026-11-13",
			words: "w",
			decides: "d",
			source: "card",
			status: "retired",
			confirmed: true,
			confirmedAt: "2026-11-13T10:00:00.000Z",
			retiredAt: "2026-11-13T11:00:00.000Z",
			retiredHow: "superseded",
			retiredWhy: "replaced by R6",
			supersededBy: "R6",
			supersedes: ["R1", "R2"],
			expires: "2026-12-01T09:00:00Z",
			until: "the launch",
			item: "Q-abc12",
			history: [{ t: "t", what: "x" }],
		});
		expect(readRulings(d)[0]).toEqual({
			id: "R5",
			date: "2026-11-13",
			words: "w",
			decides: "d",
			source: "card",
			status: "retired",
			confirmed: true,
			confirmedAt: "2026-11-13T10:00:00.000Z",
			retiredAt: "2026-11-13T11:00:00.000Z",
			retiredHow: "superseded",
			retiredWhy: "replaced by R6",
			supersededBy: "R6",
			supersedes: ["R1", "R2"],
			expires: "2026-12-01T09:00:00Z",
			until: "the launch",
			item: "Q-abc12",
			history: [{ t: "t", what: "x" }],
		});
	});
	test("a ruling with none of them reads back with none of them", () => {
		const d = memStore();
		addInForce(d, { words: "w", decides: "d", source: "chat", how: "x" });
		const r = readRulings(d)[0]!;
		for (const k of ["retiredWhy", "supersededBy", "supersedes", "expires", "until"]) expect(r).not.toHaveProperty(k);
	});
	test("an update that changes only a new field is saved", () => {
		const d = memStore();
		addInForce(d, { words: "w", decides: "d", source: "chat", how: "x" });
		updateRulings(d, (list) => {
			list[0]!.expires = "2026-12-01";
		});
		expect(readRulings(d)[0]!.expires).toBe("2026-12-01");
	});
	test("the table refuses a retiredHow it does not know", () => {
		const d = memStore();
		expect(() =>
			d.rulings.save({
				id: "R1",
				date: "d",
				words: "w",
				decides: "d",
				source: "chat",
				status: "retired",
				confirmed: true,
				retiredHow: "bogus" as never,
				history: [],
			}),
		).toThrow();
	});
});
