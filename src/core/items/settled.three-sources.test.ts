/** settled, continued: see settled.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { answered, DEFAULT, find, q } from "../../testing/core-settled-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { parseSettings } from "../config/config.ts";
import { addInForce, propose } from "../ops/rulings.ts";
import { retireRuling } from "../ops/rulings-change.ts";
import { askQuestion, QUEUE } from "./questions.ts";
import { findSettled, refusalLines } from "./settled.ts";

describe("the three sources", () => {
	test("only rulings in force now are settled: a proposal, a retired, a superseded or an expired ruling is not", () => {
		const store = memStore();
		const NOW = () => Date.parse("2026-11-13T12:00:00Z");
		propose(store, { words: "keep the nightly export", decides: "Keep the nightly export running on weekends" });
		expect(find(store, { title: "Nightly export on weekends: keep running?" }).matches).toEqual([]);
		const ruling = addInForce(store, {
			words: "no Friday deploys",
			decides: "Freeze production deploys every Friday afternoon",
			source: "chat",
			how: "stated in chat",
		});
		retireRuling(store, ruling.id, { how: "retired" });
		expect(find(store, { title: "Production deploys Friday afternoon freeze?" }).matches).toEqual([]);
		addInForce(store, {
			words: "the cache stays",
			decides: "Keep the image cache warm across restarts",
			source: "chat",
			how: "stated in chat",
		});
		expect(find(store, { title: "Keep image cache warm?" }).matches.map((m) => m.answer)).toEqual([
			"in force: Keep the image cache warm across restarts",
		]);
		// Superseded: the old one settles nothing, the one that replaced it does.
		const old = addInForce(store, {
			words: "staging resets",
			decides: "Reset the staging database every Monday morning",
			source: "chat",
			how: "stated in chat",
		});
		addInForce(store, {
			words: "staging resets weekly",
			decides: "Reset staging on Sundays instead",
			source: "chat",
			how: "stated in chat",
			opts: { supersedes: [old.id] },
		});
		expect(find(store, { title: "Staging database Monday morning reset?" }).matches).toEqual([]);
		// Expired: in force until its day ends, settled nothing after.
		addInForce(
			store,
			{
				words: "the banner stays",
				decides: "Keep the maintenance banner on the login page",
				source: "chat",
				how: "stated in chat",
				opts: { expires: "2026-11-20" },
			},
			NOW,
		);
		const banner = { title: "Maintenance banner on the login page: keep it?" };
		expect(
			findSettled(store, banner, DEFAULT, () => Date.parse("2026-11-20T23:00:00Z")).matches.map((m) => m.id),
		).toEqual(["R6"]);
		expect(findSettled(store, banner, DEFAULT, () => Date.parse("2026-11-21T00:00:00Z")).matches).toEqual([]);
	});
	test("the decision log is settled; an open question never is", () => {
		const store = memStore();
		store.decisions.append({
			t: "2026-11-05T12:00:00.000Z",
			thread: "x",
			decision: "Pinned the queue worker to two replicas",
			ruling: "R3",
			ref: null,
		});
		askQuestion(store, q("Q-open1", "Upgrade the search cluster to version nine"));
		expect(find(store, { title: "Queue worker replicas pinned to two?" }).matches.map((m) => [m.source, m.id])).toEqual(
			[["decision", "D@2026-11-05T12:00"]],
		);
		expect(find(store, { title: "Upgrade the search cluster to version nine" }).matches).toEqual([]);
	});
	test("a malformed record is skipped and counted, and the valid ones still match", () => {
		const store = memStore();
		store.decisions.append({
			t: "2026-11-05T12:00:00.000Z",
			thread: "x",
			decision: "Rename to Atlas is off",
			ruling: "R1",
			ref: null,
		});
		store.items.observe({
			source: QUEUE,
			kind: "question",
			dedupKey: "Q-bad01",
			mode: "silenced",
			payload: { ...q("Q-bad01", "x"), title: 42 },
			now: Date.now(),
		});
		store.items.resolve(QUEUE, "Q-bad01", Date.now(), { answeredOnCard: true });
		const r = find(store, { title: "Rename to Atlas?" });
		expect(r.matches.map((m) => m.answer)).toEqual(["decided: Rename to Atlas is off (R1)"]);
		expect(r.skipped).toEqual(["1 malformed record"]);
	});
	test("the refusal lists each match with what it matched on, and how to override", () => {
		const out = refusalLines(
			"ask.ts",
			[
				{
					source: "queue",
					date: "2026-11-11",
					id: "Q-x0001",
					answer: 'answered "No"',
					why: "title overlap: rename, atlas",
				},
			],
			'add "notSettled"',
		);
		expect(out[0]).toContain("refused, this looks already settled");
		expect(out[1]).toBe('  queue | 2026-11-11 | Q-x0001 | answered "No" [matched on title overlap: rename, atlas]');
		expect(out.at(-1)).toContain('add "notSettled"');
	});

	test("a resolved secret's title words never appear in a later ask refusal (#102)", () => {
		const store = memStore();
		const secretTitle = "SYNTH-SETTLED-SECRET-TITLE rotate billing webhook signing";
		answered(store, "Q-secr1", secretTitle, { secret: true, options: [], kind: "only-you" });
		const r = find(store, {
			title: "Rotate the billing webhook signing SYNTH-SETTLED-SECRET-TITLE now",
		});
		const why = r.matches.map((m) => m.why).join(" | ");
		const lines = refusalLines("ask.ts", r.matches, 'add "notSettled"').join("\n");
		expect(why).not.toContain("SYNTH-SETTLED-SECRET-TITLE");
		expect(lines).not.toContain("SYNTH-SETTLED-SECRET-TITLE");
		// No match may rest on the secret's real title words.
		expect(r.matches.some((m) => m.id === "Q-secr1" && m.why.includes("title overlap"))).toBe(false);
	});
});

describe("settings.json settledMatch", () => {
	test("accepts the two keys and refuses anything else", () => {
		expect(parseSettings({ settledMatch: { titleOverlap: false, ignoreWords: [" acme "] } }).settledMatch).toEqual({
			titleOverlap: false,
			ignoreWords: ["acme"],
		});
		expect(() => parseSettings({ settledMatch: { titleOverlap: "no" } })).toThrow("titleOverlap");
		expect(() => parseSettings({ settledMatch: { ignoreWords: [1] } })).toThrow("ignoreWords");
		expect(() => parseSettings({ settledMatch: { fuzzy: true } })).toThrow("unknown keys");
		expect(() => parseSettings({ settledMatch: [] })).toThrow("must be an object");
	});
});
