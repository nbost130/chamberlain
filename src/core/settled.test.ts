/**
 * (b) The settled check: what matches, what it says it matched on, and the false-positive and false-negative boundaries
 * of each rule. Every case runs on a real Store (in memory), through findSettled, as ask.ts and `afk.ts hold` call it.
 */
import { describe, expect, test } from "bun:test";
import { memStore } from "../testing/store.ts";
import { parseSettings, type SettledMatch } from "./config.ts";
import { askQuestion, claimWake, pageClaim, QUEUE, type Question } from "./questions.ts";
import { addInForce, propose, retireRuling } from "./rulings.ts";
import { findSettled, matchSettings, refusalLines, sameTopic, titlesOverlap, tokens } from "./settled.ts";
import type { Store } from "./store.ts";

const DEFAULT: SettledMatch = {};
const q = (id: string, title: string, over: Partial<Question> = {}): Question => ({ id, kind: "product", title, context: "", options: [{ label: "Yes" }, { label: "No" }], thread: "Thread", server: "main", createdAt: "2026-11-10T10:00:00.000Z", ...over });
/** An answered question, as the page leaves it: the item and its claim. */
function answered(store: Store, id: string, title: string, over: Partial<Question> = {}, label = "No") {
	const item = q(id, title, over);
	askQuestion(store, item);
	claimWake(store, pageClaim(item, { choice: 1, label, by: "page", t: "2026-11-11T09:00:00.000Z", deliveryId: `answer:item:${id}` }));
}
const find = (store: Store, s: Parameters<typeof findSettled>[1], m: SettledMatch = DEFAULT) => findSettled(store, s, m);

describe("strong refs: one shared is a match", () => {
	test("a shared commit SHA, a run ID or the item ID in the title matches, and says which", () => {
		const store = memStore();
		answered(store, "Q-sha01", "Ship it?", { context: "- head is 1a2b3c4d5e" });
		answered(store, "Q-run01", "Retry the pipeline?", { context: "- run 01JABCDEFGHJK failed" });
		expect(find(store, { title: "Approve something", context: "- at 1a2b3c4" }).matches.map((m) => [m.id, m.why])).toEqual([["Q-sha01", "commit 1a2b3c4"]]);
		expect(find(store, { title: "Pipeline again", run: "01JABCDEFGHJK" }).matches.map((m) => [m.id, m.why])).toEqual([["Q-run01", "run 01JABCDEFGHJK"]]);
		expect(find(store, { title: "Follow-up to Q-sha01" }).matches.map((m) => m.why)).toEqual(["item Q-sha01"]);
	});
	test("false positive boundary: a number that is not a SHA, a hex word, and an item ID only in the context never match", () => {
		const store = memStore();
		answered(store, "Q-sha02", "Ship it?", { context: "- head is 1a2b3c4d5e; build 1234567; defaced" });
		expect(find(store, { title: "Unrelated", context: "- build 1234567, defaced banner" }).matches).toEqual([]);
		expect(find(store, { title: "Unrelated", context: "- see Q-sha02 for background" }).matches).toEqual([]);
	});
});

describe("weak refs: a PR, branch or thread title matches only beside the same topic", () => {
	test("the same PR with a different question is a new round, not a repeat", () => {
		const store = memStore();
		answered(store, "Q-pr001", "Approve the database migration for invoices", { context: "- acme/app#962" });
		expect(find(store, { title: "Approve a new lint rule for the commands package", context: "- app#962 touches it" }).matches).toEqual([]);
	});
	test("the same PR and the same topic is a repeat, and the match names both", () => {
		const store = memStore();
		answered(store, "Q-pr002", "Approve the database migration for invoices", { context: "- acme/app#962" });
		const r = find(store, { title: "Database migration invoices approval again", pr: "acme/app#962" });
		expect(r.matches.map((m) => m.why)).toEqual(["PR/issue acme/app#962 + topic: database, migration, invoice"]);
	});
	test("a branch shared beside the topic matches; the same branch on another topic does not", () => {
		const store = memStore();
		answered(store, "Q-br001", "Rotate the billing webhook signing secret", { context: "- branch acme/app:fix/webhook" });
		expect(find(store, { title: "Billing webhook signing secret rotation", branch: "acme/app:fix/webhook" }).matches.map((m) => m.why)).toEqual(["branch acme/app:fix/webhook + topic: billing, webhook, signing, secret"]);
		expect(find(store, { title: "Flaky retry test on the payments page", branch: "acme/app:fix/webhook" }).matches).toEqual([]);
	});
});

describe("title overlap (rule 3)", () => {
	test("a short title matches its phrase inside a longer one; a paraphrase is a documented miss", () => {
		const store = memStore();
		answered(store, "Q-ttl01", "Rename the project to Atlas");
		expect(find(store, { title: "Rename to Atlas?" }).matches.map((m) => m.why)).toEqual(["title overlap: rename, atla"]);
		// False negative boundary: the same intent in other words is not caught (precision first).
		expect(find(store, { title: "Should we call it Atlas?" }).matches).toEqual([]);
	});
	test("false positive boundary: generic workflow words alone never match, nor do words far apart in a long text", () => {
		const store = memStore();
		answered(store, "Q-ttl02", "Approve deploy of the billing service");
		answered(store, "Q-ttl03", "Billing exports move first, then migrate the reporting jobs off the old cluster, rebuild dashboards, refresh alerts, and finally the invoice archive retention");
		expect(find(store, { title: "Approve deploy" }).matches).toEqual([]);
		expect(find(store, { title: "Billing invoice retention" }).matches).toEqual([]);
	});
	test("three or more words: three quarters shared, two distinctive", () => {
		expect(titlesOverlap("Rotate the billing webhook secret", "Rotate billing webhook secret now")).toEqual(["rotate", "billing", "webhook", "secret"]);
		expect(titlesOverlap("Rotate the billing webhook secret", "Billing dashboard colour scheme")).toBeUndefined();
		expect(titlesOverlap("Approve merge review gate", "Approve merge review gate today")).toBeUndefined();
	});
	test("configurable: titleOverlap false leaves only the ref rules", () => {
		const store = memStore();
		answered(store, "Q-ttl04", "Rename the project to Atlas", { context: "- at 9f8e7d6c" });
		expect(find(store, { title: "Rename to Atlas?" }, { titleOverlap: false }).matches).toEqual([]);
		expect(find(store, { title: "Rename to Atlas?", context: "- 9f8e7d6c" }, { titleOverlap: false }).matches.map((m) => m.why)).toEqual(["commit 9f8e7d6c"]);
	});
	test("ignoreWords and the principal's name say nothing about the topic", () => {
		const ignore = matchSettings({ ignoreWords: ["Acme Portal"] }).ignore;
		expect(ignore.has("acme") && ignore.has("portal") && ignore.has("operator")).toBe(true);
		expect(sameTopic("Acme portal login billing", "Acme portal login billing")).toEqual(["acme", "portal", "login", "billing"]);
		expect(sameTopic("Acme portal login billing", "Acme portal login reports", ignore)).toBeUndefined();
		// Stemming is light and literal: a plural "s" is dropped from words over four letters, so "atlas" reads "atla" in an explanation.
		expect(tokens("The Tests builds runs Atlas")).toEqual(["test", "build", "runs", "atla"]);
	});
});

describe("the three sources", () => {
	test("only rulings in force now are settled: a proposal, a retired, a superseded or an expired ruling is not", () => {
		const store = memStore();
		const NOW = () => Date.parse("2026-11-13T12:00:00Z");
		propose(store, "keep the nightly export", "Keep the nightly export running on weekends");
		expect(find(store, { title: "Nightly export on weekends: keep running?" }).matches).toEqual([]);
		const ruling = addInForce(store, "no Friday deploys", "Freeze production deploys every Friday afternoon", "chat", "stated in chat");
		retireRuling(store, ruling.id, "retired");
		expect(find(store, { title: "Production deploys Friday afternoon freeze?" }).matches).toEqual([]);
		addInForce(store, "the cache stays", "Keep the image cache warm across restarts", "chat", "stated in chat");
		expect(find(store, { title: "Keep image cache warm?" }).matches.map((m) => m.answer)).toEqual(["in force: Keep the image cache warm across restarts"]);
		// Superseded: the old one settles nothing, the one that replaced it does.
		const old = addInForce(store, "staging resets", "Reset the staging database every Monday morning", "chat", "stated in chat");
		addInForce(store, "staging resets weekly", "Reset staging on Sundays instead", "chat", "stated in chat", undefined, { supersedes: [old.id] });
		expect(find(store, { title: "Staging database Monday morning reset?" }).matches).toEqual([]);
		// Expired: in force until its day ends, settled nothing after.
		addInForce(store, "the banner stays", "Keep the maintenance banner on the login page", "chat", "stated in chat", undefined, { expires: "2026-11-20" }, NOW);
		const banner = { title: "Maintenance banner on the login page: keep it?" };
		expect(findSettled(store, banner, DEFAULT, () => Date.parse("2026-11-20T23:00:00Z")).matches.map((m) => m.id)).toEqual(["R6"]);
		expect(findSettled(store, banner, DEFAULT, () => Date.parse("2026-11-21T00:00:00Z")).matches).toEqual([]);
	});
	test("the decision log is settled; an open question never is", () => {
		const store = memStore();
		store.decisions.append({ t: "2026-11-05T12:00:00.000Z", thread: "x", decision: "Pinned the queue worker to two replicas", ruling: "R3", ref: null });
		askQuestion(store, q("Q-open1", "Upgrade the search cluster to version nine"));
		expect(find(store, { title: "Queue worker replicas pinned to two?" }).matches.map((m) => [m.source, m.id])).toEqual([["decision", "D@2026-11-05T12:00"]]);
		expect(find(store, { title: "Upgrade the search cluster to version nine" }).matches).toEqual([]);
	});
	test("a malformed record is skipped and counted, and the valid ones still match", () => {
		const store = memStore();
		store.decisions.append({ t: "2026-11-05T12:00:00.000Z", thread: "x", decision: "Rename to Atlas is off", ruling: "R1", ref: null });
		store.items.observe({ source: QUEUE, kind: "question", dedupKey: "Q-bad01", mode: "silenced", payload: { ...q("Q-bad01", "x"), title: 42 }, now: Date.now() });
		store.items.resolve(QUEUE, "Q-bad01", Date.now(), { answeredOnCard: true });
		const r = find(store, { title: "Rename to Atlas?" });
		expect(r.matches.map((m) => m.answer)).toEqual(["decided: Rename to Atlas is off (R1)"]);
		expect(r.skipped).toEqual(["1 malformed record"]);
	});
	test("the refusal lists each match with what it matched on, and how to override", () => {
		const out = refusalLines("ask.ts", [{ source: "queue", date: "2026-11-11", id: "Q-x0001", answer: 'answered "No"', why: "title overlap: rename, atlas" }], 'add "notSettled"');
		expect(out[0]).toContain("refused, this looks already settled");
		expect(out[1]).toBe('  queue | 2026-11-11 | Q-x0001 | answered "No" [matched on title overlap: rename, atlas]');
		expect(out.at(-1)).toContain('add "notSettled"');
	});
});

describe("settings.json settledMatch", () => {
	test("accepts the two keys and refuses anything else", () => {
		expect(parseSettings({ settledMatch: { titleOverlap: false, ignoreWords: [" acme "] } }).settledMatch).toEqual({ titleOverlap: false, ignoreWords: ["acme"] });
		expect(() => parseSettings({ settledMatch: { titleOverlap: "no" } })).toThrow("titleOverlap");
		expect(() => parseSettings({ settledMatch: { ignoreWords: [1] } })).toThrow("ignoreWords");
		expect(() => parseSettings({ settledMatch: { fuzzy: true } })).toThrow("unknown keys");
		expect(() => parseSettings({ settledMatch: [] })).toThrow("must be an object");
	});
});
