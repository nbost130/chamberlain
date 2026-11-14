/**
 * (b) The settled check: what matches, what it says it matched on, and the false-positive and false-negative boundaries
 * of each rule. Every case runs on a real Store (in memory), through findSettled, as ask.ts and `afk.ts hold` call it.
 */
import { describe, expect, test } from "bun:test";
import { memStore } from "../testing/store.ts";
import { parseSettings, type SettledMatch } from "./config.ts";
import { askQuestion, QUEUE, type Question } from "./questions.ts";
import { claimWake, pageClaim } from "./questions-claim.ts";
import { addInForce, propose } from "./rulings.ts";
import { retireRuling } from "./rulings-change.ts";
import { findSettled, matchSettings, refusalLines } from "./settled.ts";
import { sameTopic, titlesOverlap, tokens } from "./settled-title.ts";
import type { Store } from "./store.ts";

const DEFAULT: SettledMatch = {};
const q = (id: string, title: string, over: Partial<Question> = {}): Question => ({
	id,
	kind: "product",
	title,
	context: "",
	options: [{ label: "Yes" }, { label: "No" }],
	thread: "Thread",
	server: "main",
	createdAt: "2026-11-10T10:00:00.000Z",
	...over,
});
/** An answered question, as the page leaves it: the item and its claim. */
function answered(store: Store, id: string, title: string, over: Partial<Question> = {}, label = "No") {
	const item = q(id, title, over);
	askQuestion(store, item);
	claimWake(
		store,
		pageClaim(item, { choice: 1, label, by: "page", t: "2026-11-11T09:00:00.000Z", deliveryId: `answer:item:${id}` }),
	);
}
const find = (store: Store, s: Parameters<typeof findSettled>[1], m: SettledMatch = DEFAULT) =>
	findSettled(store, s, m);

describe("strong refs: one shared is a match", () => {
	test("a shared commit SHA, a run ID or the item ID in the title matches, and says which", () => {
		const store = memStore();
		answered(store, "Q-sha01", "Ship it?", { context: "- head is 1a2b3c4d5e" });
		answered(store, "Q-run01", "Retry the pipeline?", { context: "- run 01JABCDEFGHJK failed" });
		expect(
			find(store, { title: "Approve something", context: "- at 1a2b3c4" }).matches.map((m) => [m.id, m.why]),
		).toEqual([["Q-sha01", "commit 1a2b3c4"]]);
		expect(find(store, { title: "Pipeline again", run: "01JABCDEFGHJK" }).matches.map((m) => [m.id, m.why])).toEqual([
			["Q-run01", "run 01JABCDEFGHJK"],
		]);
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
		expect(
			find(store, { title: "Approve a new lint rule for the commands package", context: "- app#962 touches it" })
				.matches,
		).toEqual([]);
	});
	test("the same PR and the same topic is a repeat, and the match names both", () => {
		const store = memStore();
		answered(store, "Q-pr002", "Approve the database migration for invoices", { context: "- acme/app#962" });
		const r = find(store, { title: "Database migration invoices approval again", pr: "acme/app#962" });
		expect(r.matches.map((m) => m.why)).toEqual(["PR/issue acme/app#962 + topic: database, migration, invoice"]);
	});
	test("a branch shared beside the topic matches; the same branch on another topic does not", () => {
		const store = memStore();
		answered(store, "Q-br001", "Rotate the billing webhook signing secret", {
			context: "- branch acme/app:fix/webhook",
		});
		expect(
			find(store, { title: "Billing webhook signing secret rotation", branch: "acme/app:fix/webhook" }).matches.map(
				(m) => m.why,
			),
		).toEqual(["branch acme/app:fix/webhook + topic: billing, webhook, signing, secret"]);
		expect(
			find(store, { title: "Flaky retry test on the payments page", branch: "acme/app:fix/webhook" }).matches,
		).toEqual([]);
	});
});

describe("refs: every form a text can name one in, and the other ways two sides can share one", () => {
	test("a run named verbatim in the other side's text matches in either direction, and says so once", () => {
		const store = memStore();
		answered(store, "Q-run02", "Retry the pipeline?", { context: "- run 01JXYZXYZXYZX failed" });
		expect(find(store, { title: "Unrelated", context: "- see 01JXYZXYZXYZX" }).matches).toEqual([]);
		expect(find(store, { title: "Unrelated", run: "01JXYZXYZXYZX" }).matches.map((m) => m.why)).toEqual([
			"run 01JXYZXYZXYZX",
		]);
	});
	test("the PR forms (owner/repo#n, repo#n, #n, 'PR n', 'issue n') name the same PR beside the same topic", () => {
		const topic = "Approve the database migration for invoices";
		for (const context of ["acme/app#7", "app#7", "#7", "PR 7", "pull request #7", "issue 7"]) {
			const store = memStore();
			answered(store, "Q-prf01", topic, { context: `- ${context}` });
			const r = find(store, { title: "Database migration invoices approval again", pr: "acme/app#7" });
			expect([context, r.matches.length]).toEqual([context, 1]);
		}
	});
	test("a thread title named whole in the other side's text is a weak ref that still needs the topic", () => {
		const store = memStore();
		answered(store, "Q-thr01", "Rotate the billing webhook signing secret", {
			thread: "Webhook signing rotation work",
		});
		expect(
			find(store, {
				title: "Billing webhook signing secret rotation",
				context: "from Webhook signing rotation work",
			}).matches.map((m) => m.why),
		).toEqual(["thread title + topic: billing, webhook, signing, secret"]);
		expect(
			find(store, { title: "Flaky retry test on the payments page", context: "from Webhook signing rotation work" })
				.matches,
		).toEqual([]);
	});
	test("a source that cannot be read is skipped and named, and the others still answer", () => {
		const store = memStore();
		store.decisions.append({
			t: "2026-11-05T12:00:00.000Z",
			thread: "x",
			decision: "Rename to Atlas is off",
			ruling: "R1",
			ref: null,
		});
		const broken = {
			...store,
			decisions: {
				...store.decisions,
				list: () => {
					throw new Error("disk gone");
				},
			},
		} as unknown as Store;
		const r = find(broken, { title: "Rename to Atlas?" });
		expect(r.skipped).toEqual(["decisions (disk gone)"]);
	});
});

describe("title overlap (rule 3)", () => {
	test("a short title matches its phrase inside a longer one; a paraphrase is a documented miss", () => {
		const store = memStore();
		answered(store, "Q-ttl01", "Rename the project to Atlas");
		expect(find(store, { title: "Rename to Atlas?" }).matches.map((m) => m.why)).toEqual([
			"title overlap: rename, atla",
		]);
		// False negative boundary: the same intent in other words is not caught (precision first).
		expect(find(store, { title: "Should we call it Atlas?" }).matches).toEqual([]);
	});
	test("false positive boundary: generic workflow words alone never match, nor do words far apart in a long text", () => {
		const store = memStore();
		answered(store, "Q-ttl02", "Approve deploy of the billing service");
		answered(
			store,
			"Q-ttl03",
			"Billing exports move first, then migrate the reporting jobs off the old cluster, rebuild dashboards, refresh alerts, and finally the invoice archive retention",
		);
		expect(find(store, { title: "Approve deploy" }).matches).toEqual([]);
		expect(find(store, { title: "Billing invoice retention" }).matches).toEqual([]);
	});
	test("three or more words: three quarters shared, two distinctive", () => {
		expect(titlesOverlap("Rotate the billing webhook secret", "Rotate billing webhook secret now")).toEqual([
			"rotate",
			"billing",
			"webhook",
			"secret",
		]);
		expect(titlesOverlap("Rotate the billing webhook secret", "Billing dashboard colour scheme")).toBeUndefined();
		expect(titlesOverlap("Approve merge review gate", "Approve merge review gate today")).toBeUndefined();
	});
	test("configurable: titleOverlap false leaves only the ref rules", () => {
		const store = memStore();
		answered(store, "Q-ttl04", "Rename the project to Atlas", { context: "- at 9f8e7d6c" });
		expect(find(store, { title: "Rename to Atlas?" }, { titleOverlap: false }).matches).toEqual([]);
		expect(
			find(store, { title: "Rename to Atlas?", context: "- 9f8e7d6c" }, { titleOverlap: false }).matches.map(
				(m) => m.why,
			),
		).toEqual(["commit 9f8e7d6c"]);
	});
	test("ignoreWords and the principal's name say nothing about the topic", () => {
		const ignore = matchSettings({ ignoreWords: ["Acme Portal"] }).ignore;
		expect(ignore.has("acme") && ignore.has("portal") && ignore.has("operator")).toBe(true);
		expect(sameTopic("Acme portal login billing", "Acme portal login billing")).toEqual([
			"acme",
			"portal",
			"login",
			"billing",
		]);
		expect(sameTopic("Acme portal login billing", "Acme portal login reports", ignore)).toBeUndefined();
		// Stemming is light and literal: a plural "s" is dropped from words over four letters, so "atlas" reads "atla" in an explanation.
		expect(tokens("The Tests builds runs Atlas")).toEqual(["test", "build", "runs", "atla"]);
	});
	test("ignoreWords count on the title-overlap path too, case-insensitively: an ignored product name never carries a match", () => {
		const store = memStore();
		answered(store, "Q-ign01", "Acme deployment");
		// The case: with "Acme" ignored, the settled two-word title is one word, so it settles nothing new.
		for (const ignoreWords of [["Acme"], ["ACME"], ["acme"]])
			expect(find(store, { title: "Acme deployment database rollback?" }, { ignoreWords }).matches).toEqual([]);
		// Without the setting it is the documented phrase match, so the ignore is what changed it.
		expect(find(store, { title: "Acme deployment database rollback?" }).matches.map((m) => m.id)).toEqual(["Q-ign01"]);
		expect(titlesOverlap("Acme deployment", "Acme deployment database rollback?", new Set(["acme"]))).toBeUndefined();
	});
	test("(C) an ignored word never counts as a distinctive word, in a two-word title or a longer one", () => {
		const ignore = new Set(["acme"]);
		// "deploy" is generic, so without the ignore "acme" is the one distinctive word that makes these match.
		expect(titlesOverlap("Acme deploy", "Acme deploy window")).toEqual(["acme", "deploy"]);
		expect(titlesOverlap("Acme deploy", "Acme deploy window", ignore)).toBeUndefined();
		expect(titlesOverlap("Acme deploy", "Acme deploy", ignore)).toBeUndefined();
		// Longer: two distinctive words are needed, and "acme" may not be one of them.
		expect(titlesOverlap("Acme billing approve merge", "Acme billing approve merge today")).toEqual([
			"acme",
			"billing",
			"approve",
			"merge",
		]);
		expect(titlesOverlap("Acme billing approve merge", "Acme billing approve merge today", ignore)).toBeUndefined();
		const store = memStore();
		answered(store, "Q-ignc1", "Acme deploy");
		expect(find(store, { title: "Acme deploy window?" }, { ignoreWords: ["acme"] }).matches).toEqual([]);
	});
	test("a true repeat still matches with the product name ignored, and the match names no ignored word", () => {
		const store = memStore();
		answered(store, "Q-ign02", "Acme billing invoice retry policy");
		const r = find(store, { title: "ACME billing invoice retry policy again?" }, { ignoreWords: ["Acme"] });
		expect(r.matches.map((m) => [m.id, m.why])).toEqual([
			["Q-ign02", "title overlap: billing, invoice, retry, policy"],
		]);
	});
});

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
