import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { eventRows, everything, OTHER_THREAD, THREAD } from "../../testing/obs.ts";
import { MARK } from "../../testing/secrets.ts";
import { memStore } from "../../testing/store.ts";
import { appendHeld, closeHeld, heldId } from "../afk.ts";
import { closeCardQuestions } from "../card-hold.ts";
import { decisionRecord } from "../decided.ts";
import { obsFor } from "../log.ts";
import { type Answer, askQuestion, claimWake, pageClaim, QUEUE, type Question } from "../questions.ts";
import { openStore } from "../sqlite-store.ts";
import { dbPath, type Store } from "../store.ts";
import { openLedger } from "./db.ts";
import { corrOf } from "./fields.ts";
import { ledgerEvents, reconcile, reconcileStore, startReconciler } from "./ledger.ts";

const dirs: string[] = [];
const stores: Store[] = [];
afterEach(() => {
	for (const s of stores.splice(0)) s.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
	const d = mkdtempSync(`${tmpdir()}/chamberlain-ledger-`);
	dirs.push(d);
	return d;
};
const open = (dir: string) => {
	const s = openStore(dbPath(dir));
	stores.push(s);
	return s;
};

const question = (id: string, extra: Partial<Question> = {}): Question => ({
	id,
	kind: "product",
	title: `Ship ${MARK} to the billing page?`,
	context: `context ${MARK}`,
	options: [{ label: `Yes ${MARK}` }, { label: "No" }, { label: "Later" }],
	recommended: 1,
	thread: `Billing ${MARK}`,
	server: "main",
	threadId: THREAD,
	createdAt: "2026-11-13T00:00:00.000Z",
	...extra,
});
const answerOf = (id: string, choice: number, by: "page" | "batch", t: string): Answer => ({
	choice,
	label: `label ${MARK}`,
	note: `a note ${MARK}`,
	by,
	t,
	deliveryId: `answer:item:${id}`,
});

/** A ledger the way it was before telemetry existed: rows of every kind, and no obs.db. */
function oldLedger(dir: string) {
	const store = open(dir);
	askQuestion(store, question("Q-aaaa1"), Date.parse("2026-11-13T00:00:00.000Z"));
	askQuestion(
		store,
		question("Q-bbbb2", { threadId: "not-a-uuid", options: [{ label: "A" }, { label: "B" }] }),
		Date.parse("2026-11-13T00:10:00.000Z"),
	);
	askQuestion(
		store,
		question("Q-cccc3", { secret: true, cardRequest: "req-1" }),
		Date.parse("2026-11-13T00:20:00.000Z"),
	);
	askQuestion(store, question("Q-dddd4"), Date.parse("2026-11-13T00:30:00.000Z"));
	claimWake(store, pageClaim(question("Q-aaaa1"), answerOf("Q-aaaa1", 1, "page", "2026-11-13T01:00:00.000Z")));
	claimWake(store, pageClaim(question("Q-bbbb2"), answerOf("Q-bbbb2", 0, "batch", "2026-11-13T02:00:00.000Z")));
	store.items.resolve(QUEUE, "Q-cccc3", Date.parse("2026-11-13T03:00:00.000Z"), { answeredOnCard: true });
	for (const [i, thread] of [THREAD, "Deploy the billing fix", OTHER_THREAD].entries())
		store.decisions.append(
			decisionRecord(
				thread,
				`decided ${MARK} ${i}`,
				i === 0 ? "R12, R30: words" : "no ruling",
				undefined,
				`2026-11-12T0${i}:00:00.000Z`,
			),
		);
	const h1 = appendHeld(
		store,
		{ thread: "T1", what: `held ${MARK}`, item: "Q-dddd4" },
		new Date("2026-11-13T00:40:00.000Z"),
	);
	const h2 = appendHeld(
		store,
		{ thread: "T2", what: "held two", requestId: "req-9", server: "main" },
		new Date("2026-11-13T00:41:00.000Z"),
	);
	appendHeld(store, { thread: "T3", what: "still open" }, new Date("2026-11-13T00:42:00.000Z"));
	closeHeld(store, h1, "answered", new Date("2026-11-13T05:00:00.000Z"));
	closeHeld(store, h2, "card gone", new Date("2026-11-13T05:30:00.000Z"));
	store.close();
	stores.splice(stores.indexOf(store), 1);
	// What this build wrote inline is not what an old build wrote: remove it, so the reconciler starts from a ledger with no events at all.
	for (const f of readdirSync(dir)) if (f.startsWith("obs.db")) rmSync(`${dir}/${f}`);
	return { h1, h2 };
}

const keysOf = (store: Store) =>
	eventRows(obsFor(store), "source_key IS NOT NULL")
		.map((r) => r.source_key as string)
		.sort();

describe("the backfill is the reconciler", () => {
	test("after it, every ledger row has exactly one event, and running it again adds none", () => {
		const dir = scratch();
		const { h1, h2 } = oldLedger(dir);
		const store = open(dir);
		const first = reconcileStore(store, { graceMs: 0 });
		expect(first).toMatchObject({ scanned: 3 + 4 + 3 + 2, emitted: 3 + 4 + 3 + 2, skipped: 0 });
		expect(keysOf(store)).toEqual(
			[
				"decision:1",
				"decision:2",
				"decision:3",
				"item:Q-aaaa1:asked",
				"item:Q-bbbb2:asked",
				"item:Q-cccc3:asked",
				"item:Q-dddd4:asked",
				"item:Q-aaaa1:answered",
				"item:Q-bbbb2:answered",
				"item:Q-cccc3:answered",
				`hold:${h1}:closed`,
				`hold:${h2}:closed`,
			].sort(),
		);
		const before = eventRows(obsFor(store)).length;
		expect(reconcileStore(store, { graceMs: 0 })).toMatchObject({ scanned: 12, emitted: 0 });
		expect(eventRows(obsFor(store))).toHaveLength(before);
		// Every ledger table's row count equals its events' count: one each, no extras.
		const ledger = openLedger(dbPath(dir));
		const n = (sql: string) => (ledger.query(sql).get() as { n: number }).n;
		expect(eventRows(obsFor(store), "event = 'decision.logged'")).toHaveLength(
			n("SELECT COUNT(*) AS n FROM decisions"),
		);
		expect(eventRows(obsFor(store), "event = 'question.asked'")).toHaveLength(
			n("SELECT COUNT(*) AS n FROM items WHERE source = 'queue' AND kind = 'question'"),
		);
		expect(eventRows(obsFor(store), "event = 'question.answered'")).toHaveLength(
			n("SELECT COUNT(*) AS n FROM claims WHERE answer IS NOT NULL") + 1,
		);
		expect(eventRows(obsFor(store), "event = 'hold.closed'")).toHaveLength(
			n("SELECT COUNT(*) AS n FROM items WHERE source = 'held' AND state = 'resolved'"),
		);
		ledger.close();
	});

	test("the old table got the same rows under the same keys, once", () => {
		const dir = scratch();
		oldLedger(dir);
		const store = open(dir);
		reconcileStore(store, { graceMs: 0 });
		reconcileStore(store, { graceMs: 0 });
		const old = store.events.query().filter((e) => /^(decision|question|hold)\./.test(e.event));
		expect(old).toHaveLength(12);
		expect(old.filter((e) => e.event === "decision.logged")).toHaveLength(3);
	});

	test("historical rows have corr = NULL and carry their ledger time", () => {
		const dir = scratch();
		oldLedger(dir);
		const store = open(dir);
		reconcileStore(store, { graceMs: 0 });
		const rows = eventRows(obsFor(store), "source_key IS NOT NULL");
		expect(rows.every((r) => r.corr === null)).toBe(true);
		expect(eventRows(obsFor(store), "source_key = 'item:Q-aaaa1:asked'")[0]?.t).toBe("2026-11-13T00:00:00.000Z");
		expect(eventRows(obsFor(store), "source_key = 'decision:2'")[0]?.t).toBe("2026-11-12T01:00:00.000Z");
	});

	test("the events are typed facts: counts, flags, a choice and durations, never a title, a note or a decision's words", () => {
		const dir = scratch();
		oldLedger(dir);
		const store = open(dir);
		reconcileStore(store, { graceMs: 0 });
		const obs = obsFor(store);
		const data = (key: string) =>
			JSON.parse(eventRows(obs, `source_key = '${key}'`)[0]?.data ?? "{}") as Record<string, unknown>;
		expect(data("item:Q-aaaa1:asked")).toEqual({
			item: "Q-aaaa1",
			options: 3,
			recommended: 1,
			urgent: true,
			own_thread: false,
			card: false,
		});
		expect(data("item:Q-cccc3:asked")).toMatchObject({ own_thread: true, card: true });
		expect(data("item:Q-aaaa1:answered")).toEqual({
			item: "Q-aaaa1",
			choice: 1,
			recommended: true,
			by: "page",
			wait_ms: 3600_000,
			ruled: false,
		});
		expect(data("item:Q-bbbb2:answered")).toMatchObject({ choice: 0, recommended: false, by: "batch" });
		expect(data("item:Q-cccc3:answered")).toMatchObject({ by: "card" });
		expect(data("decision:1")).toEqual({ cited: 2 });
		expect(data("decision:2")).toEqual({ cited: 0 });
		expect(eventRows(obs, "source_key = 'decision:1'")[0]?.thread).toBe(THREAD);
		expect(eventRows(obs, "source_key = 'decision:2'")[0]?.thread).toBeNull();
		expect(eventRows(obs, "source_key = 'item:Q-bbbb2:asked'")[0]?.thread).toBeNull();
		expect(everything(obs)).not.toContain(MARK);
		expect(everything(obs).toLowerCase()).not.toMatch(/billing|deploy the|decided|held two/);
		expect(obs.counters).toEqual({ rejected: 0, redacted: 0, failed: 0, dropped: 0 });
	});

	test("it reads the ledger through a read-only handle and writes nothing to it", () => {
		const dir = scratch();
		oldLedger(dir);
		const ledger = openLedger(dbPath(dir));
		expect(() => ledger.exec("DELETE FROM decisions")).toThrow();
		expect(() => ledger.exec("CREATE TABLE events_copy (x)")).toThrow();
		const count = (ledger.query("SELECT COUNT(*) AS n FROM decisions").get() as { n: number }).n;
		const store = open(dir);
		reconcileStore(store, { graceMs: 0 });
		expect((ledger.query("SELECT COUNT(*) AS n FROM decisions").get() as { n: number }).n).toBe(count);
		const tables = (
			ledger.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
		).map((t) => t.name);
		expect(tables.some((t) => t.startsWith("obs_"))).toBe(false);
		ledger.close();
	});

	test("a row younger than the grace is left to its writer; an in-memory store has nothing to reconcile", () => {
		const dir = scratch();
		const store = open(dir);
		askQuestion(store, question("Q-fresh1"), Date.now());
		rmSync(`${dir}/obs.db`, { force: true });
		const r = reconcileStore(store);
		expect(r).toMatchObject({ emitted: 0 });
		expect(memStore().path).toBe(":memory:");
		expect(reconcileStore(memStore())).toBeUndefined();
	});
});

describe("the inline emission, and the repair of the one that did not happen", () => {
	test("the code that writes a ledger row emits its event with corr, once", () => {
		const dir = scratch();
		const store = open(dir);
		askQuestion(store, question("Q-inl01"));
		askQuestion(store, question("Q-inl01"));
		claimWake(
			store,
			pageClaim(question("Q-inl01"), answerOf("Q-inl01", 1, "page", new Date(Date.now() + 5000).toISOString())),
		);
		ledgerEvents(store).answered("Q-inl01", answerOf("Q-inl01", 1, "page", new Date(Date.now() + 5000).toISOString()));
		const h = appendHeld(store, { thread: "T", what: "w" });
		closeHeld(store, h, "done");
		store.decisions.append(decisionRecord(THREAD, "d", "R1", undefined));
		ledgerEvents(store).decision(1, decisionRecord(THREAD, "d", "R1", undefined));
		const rows = eventRows(obsFor(store), "source_key IS NOT NULL");
		expect(rows.map((r) => r.source_key).sort()).toEqual(
			["decision:1", `hold:${h}:closed`, "item:Q-inl01:answered", "item:Q-inl01:asked"].sort(),
		);
		for (const r of rows.filter((x) => x.source_key?.startsWith("item:"))) expect(r.corr).toBe(corrOf("item:Q-inl01"));
		expect(rows.find((r) => r.source_key === "decision:1")?.corr).toBeNull();
	});

	test("an event inside a transaction that rolls back is never emitted", () => {
		const store = open(scratch());
		expect(() =>
			store.tx(() => {
				askQuestion(store, question("Q-roll1"));
				throw Error("rolled back");
			}),
		).toThrow();
		expect(keysOf(store)).toEqual([]);
		store.tx(() => {
			askQuestion(store, question("Q-roll2"));
			expect(keysOf(store)).toEqual([]);
		});
		expect(keysOf(store)).toEqual(["item:Q-roll2:asked"]);
	});

	test("a card that closes its questions emits their answers", () => {
		const store = open(scratch());
		askQuestion(store, question("Q-card9", { cardRequest: "req-5" }));
		closeCardQuestions(store, "main", "req-5");
		expect(keysOf(store)).toEqual(["item:Q-card9:answered", "item:Q-card9:asked"]);
	});

	test("a lost inline event is put back by the reconciler, and only that one", () => {
		const dir = scratch();
		const store = open(dir);
		askQuestion(store, question("Q-lost1"), Date.parse("2026-11-13T00:00:00.000Z"));
		askQuestion(store, question("Q-kept1"), Date.parse("2026-11-13T00:00:00.000Z"));
		const obs = obsFor(store);
		obs.handle?.exec("DELETE FROM events WHERE source_key = 'item:Q-lost1:asked'");
		expect(reconcileStore(store, { graceMs: 0 })).toMatchObject({ emitted: 1 });
		expect(keysOf(store)).toEqual(["item:Q-kept1:asked", "item:Q-lost1:asked"]);
		expect(eventRows(obs, "source_key = 'item:Q-lost1:asked'")[0]?.corr).toBeNull();
		expect(eventRows(obs, "source_key = 'item:Q-kept1:asked'")[0]?.corr).toBe(corrOf("item:Q-kept1"));
	});

	test("a telemetry failure never fails the ledger write", () => {
		const store = open(scratch());
		const obs = obsFor(store);
		obs.close();
		expect(() => askQuestion(store, question("Q-fail1"))).not.toThrow();
		expect(store.items.get(QUEUE, "Q-fail1")).toBeDefined();
	});
});

describe("the schedule", () => {
	test("a pass runs soon after start and the timer stops", async () => {
		const dir = scratch();
		oldLedger(dir);
		const store = open(dir);
		const stop = startReconciler(store, { graceMs: 0 });
		await Bun.sleep(100);
		stop();
		expect(keysOf(store)).toHaveLength(12);
	});

	test("reconcile() on a ledger it cannot read changes nothing and throws nothing", () => {
		const store = open(scratch());
		const obs = obsFor(store);
		const broken = {
			query: () => {
				throw Error("no such table");
			},
		} as never;
		expect(reconcile(obs, broken, { graceMs: 0 })).toEqual({ scanned: 0, emitted: 0, skipped: 0 });
	});
});

void heldId;
