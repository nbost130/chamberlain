/**
 * Rulings hygiene: recording is idempotent in the store, a ruling can expire (against a clock the test supplies) and can replace
 * others, and a ruling can leave force for a housekeeping reason that is kept with it.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { at, NOW } from "../../testing/core-rulings-hygiene-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { openStore } from "../store/sqlite-store.ts";
import { addInForce, propose, readRulings } from "./rulings.ts";
import { confirmRuling, retireRuling } from "./rulings-change.ts";
import { expiresAt, isExpired } from "./rulings-expiry.ts";
import { expiredNow, inForceNow, renderExpired, renderInForce, rulingsBriefText, rulingsText } from "./rulings-read.ts";

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
			{
				words: "w",
				decides: "d",
				source: "chat",
				how: "x",
				opts: { expires: "2026-12-01", until: "the launch" },
			},
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
		expect(brief).toContain("- R1:");
		expect(brief).not.toContain("- R2:");
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
