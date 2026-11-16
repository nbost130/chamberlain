/** rulings-hygiene, continued: see rulings-hygiene.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { memStore } from "../../testing/store.ts";
import { addInForce, readRulings, updateRulings } from "./rulings.ts";

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
