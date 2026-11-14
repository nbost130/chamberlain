/** rulings-hygiene, continued: see rulings-hygiene.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { NOW } from "../testing/core-rulings-hygiene-fixtures.ts";
import { memStore } from "../testing/store.ts";
import { addInForce, propose, readRulings, updateRulings } from "./rulings.ts";
import { confirmRuling, retireRuling } from "./rulings-change.ts";
import { rulingsText } from "./rulings-read.ts";

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
