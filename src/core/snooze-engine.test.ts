/**
 * The daemon's part of a snooze: when a snoozed question's time comes, the engine's tick records the return once, tells its afk hold and
 * shows an urgent question where the operator reads again. The item itself is back on the active list without it (src/core/snooze.test.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { noAlert } from "../testing/alert.ts";
import { createFakeAdapter } from "../testing/fake-adapter.ts";
import { testRelayLock } from "../testing/lock.ts";
import { memStore } from "../testing/store.ts";
import { appendHeld, HELD, heldOpen } from "./afk-held.ts";
import { createEngine } from "./engine.ts";
import type { EngineDeps } from "./engine-support.ts";
import { askQuestion, type Question, questionStates } from "./questions.ts";
import { claimWake, pageClaim } from "./questions-claim.ts";
import { plainAnswer, ranked } from "./questions-wake.ts";
import { snoozeQuestion, unsnoozeQuestion } from "./snooze.ts";
import { openStore } from "./sqlite-store.ts";
import { dbPath, type Store } from "./store.ts";

const T0 = Date.parse("2026-11-14T12:00:00.000Z");
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const dirs: string[] = [];
const engines: { stop: () => Promise<void> }[] = [];
afterEach(async () => {
	for (const e of engines.splice(0)) await e.stop();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const question = (id: string, over: Partial<Question> = {}): Question => ({
	id,
	kind: "product",
	title: `Which plan for ${id}`,
	context: "",
	options: [{ label: "A" }, { label: "B" }],
	thread: "Launch thread",
	server: "main",
	threadId: "thread-1",
	createdAt: "2026-11-14T08:00:00.000Z",
	...over,
});

/** An engine with no watchers' traffic, a clock the test moves, and the events it logged. It is never started: the test calls its tick. */
function rig(store: Store, o: { dry?: boolean; post?: EngineDeps["post"] } = {}) {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-snooze-eng-`);
	dirs.push(root);
	const conf = `${root}/conf`;
	mkdirSync(conf, { recursive: true, mode: 0o700 });
	const fake = createFakeAdapter();
	const clock = { t: T0 };
	const events: { event: string; [k: string]: unknown }[] = [];
	const engine = createEngine({
		conf,
		lock: testRelayLock(store),
		alert: noAlert,
		store,
		dry: o.dry,
		housekeeping: false,
		...(o.post ? { post: o.post } : {}),
		servers: [{ server: { name: "fake", adapter: "fake" }, adapter: fake }],
		log: (event, data) => events.push({ event, ...data }),
		relay: { retryAfterMs: () => 0, now: () => clock.t },
	});
	engines.push(engine);
	return { engine, fake, clock, events, tick: () => engine.tick() };
}
const hold = (store: Store, id: string) =>
	appendHeld(store, { thread: "Launch thread", what: `waits on ${id}`, item: id }, new Date(T0 - HOUR));

describe("the return notice", () => {
	test("an urgent question is shown again, once, when its time comes; its hold stays open with a note", async () => {
		const store = memStore();
		askQuestion(store, question("Q-aaaa"));
		askQuestion(store, question("Q-bbbb"));
		const h = hold(store, "Q-aaaa");
		snoozeQuestion(store, "Q-aaaa", iso(T0 + HOUR), T0);
		const r = rig(store);
		await r.tick();
		expect(r.fake.posted).toEqual([]);
		r.clock.t = T0 + HOUR - 1;
		await r.tick();
		expect(r.fake.posted).toEqual([]);
		r.clock.t = T0 + HOUR;
		await r.tick();
		expect(r.fake.posted.map((p) => p.item.id)).toEqual(["Q-aaaa"]);
		// what is posted is the question as filed: no snooze, no status
		expect(Object.keys(r.fake.posted[0]!.item).sort()).toEqual(Object.keys(question("Q-aaaa")).sort());
		await r.tick();
		r.clock.t = T0 + 9 * HOUR;
		await r.tick();
		expect(r.fake.posted).toHaveLength(1);
		expect(r.events.filter((e) => e.event === "snooze-returned")).toEqual([
			{ event: "snooze-returned", id: "Q-aaaa", notified: true },
		]);
		expect(heldOpen(store)).toHaveLength(1);
		const notes = ((store.items.get(HELD, h)?.payload.notes ?? []) as { text: string }[]).map((n) => n.text);
		expect(notes).toHaveLength(2);
		expect(notes[1]).toContain("back on the active list");
		expect(ranked(questionStates(store, r.clock.t).values()).map((i) => i.id)).toEqual(["Q-aaaa", "Q-bbbb"]);
	});

	test("a question that can wait comes back without a notice, as it was filed", async () => {
		const store = memStore();
		askQuestion(store, question("Q-late", { urgent: false }));
		snoozeQuestion(store, "Q-late", iso(T0 + HOUR), T0);
		const r = rig(store);
		r.clock.t = T0 + HOUR;
		await r.tick();
		expect(r.fake.posted).toEqual([]);
		expect(r.events.filter((e) => e.event === "snooze-returned")).toEqual([
			{ event: "snooze-returned", id: "Q-late", notified: false },
		]);
		expect(ranked(questionStates(store, r.clock.t).values()).map((i) => i.id)).toEqual(["Q-late"]);
	});

	test("an approval or a secret is urgent whatever its field says, so it is shown again", async () => {
		const store = memStore();
		askQuestion(store, question("Q-secr", { secret: true, options: [] }));
		snoozeQuestion(store, "Q-secr", iso(T0 + HOUR), T0);
		const r = rig(store);
		r.clock.t = T0 + HOUR;
		await r.tick();
		expect(r.fake.posted.map((p) => p.item.id)).toEqual(["Q-secr"]);
	});

	test("nothing is shown for a snooze that was ended, or an item that was answered, before its time", async () => {
		const store = memStore();
		for (const id of ["Q-unsn", "Q-answ"]) {
			askQuestion(store, question(id));
			snoozeQuestion(store, id, iso(T0 + HOUR), T0);
		}
		unsnoozeQuestion(store, "Q-unsn", T0 + 1);
		claimWake(store, pageClaim(question("Q-answ"), plainAnswer("direction", "Q-answ", "go", iso(T0))));
		const r = rig(store);
		r.clock.t = T0 + 2 * HOUR;
		await r.tick();
		expect(r.fake.posted).toEqual([]);
		expect(r.events.filter((e) => e.event === "snooze-returned")).toEqual([]);
	});

	test("a dry daemon records the return and posts nothing", async () => {
		const store = memStore();
		askQuestion(store, question("Q-aaaa"));
		snoozeQuestion(store, "Q-aaaa", iso(T0 + HOUR), T0);
		const r = rig(store, { dry: true });
		r.clock.t = T0 + HOUR;
		await r.tick();
		expect(r.fake.posted).toEqual([]);
		expect(r.events.filter((e) => e.event === "snooze-returned")).toEqual([
			{ event: "snooze-returned", id: "Q-aaaa", notified: false },
		]);
	});

	test("the daemon's own poster is used when it has one (the pinned view), with the home adapter", async () => {
		const store = memStore();
		askQuestion(store, question("Q-aaaa"));
		snoozeQuestion(store, "Q-aaaa", iso(T0 + HOUR), T0);
		const seen: string[] = [];
		const r = rig(store, {
			post: async (item, adapter) => {
				seen.push(item.id);
				expect(adapter).toBe(r.fake);
				return { ok: true, detail: "view", where: "view" };
			},
		});
		r.clock.t = T0 + HOUR;
		await r.tick();
		expect(seen).toEqual(["Q-aaaa"]);
		expect(r.fake.posted).toEqual([]);
	});

	test("two urgent returns: a failure during the first leaves the second due, and the first is never shown twice", async () => {
		const store = memStore();
		for (const [id, until] of [
			["Q-aaaa", T0 + HOUR],
			["Q-bbbb", T0 + HOUR + 1],
		] as const) {
			askQuestion(store, question(id));
			snoozeQuestion(store, id, iso(until), T0);
		}
		const shown: string[] = [];
		let first = true;
		const r = rig(store, {
			post: (item) => {
				if (first) {
					first = false;
					throw Error("the process went down mid-post");
				}
				shown.push(item.id);
				return Promise.resolve({ ok: true, detail: "view", where: "view" as const });
			},
		});
		r.clock.t = T0 + 2 * HOUR;
		await r.tick();
		expect(shown).toEqual([]);
		await r.tick();
		expect(shown).toEqual(["Q-bbbb"]);
		await r.tick();
		expect(shown).toEqual(["Q-bbbb"]);
	});

	test("a notice that fails, by answer or by throwing, is logged and never retried: the item is on the list either way", async () => {
		for (const post of [
			async () => ({ ok: false, detail: "the thread is gone", where: "notice" as const }),
			async () => {
				throw Error("network down");
			},
		]) {
			const store = memStore();
			askQuestion(store, question("Q-aaaa"));
			snoozeQuestion(store, "Q-aaaa", iso(T0 + HOUR), T0);
			let calls = 0;
			const r = rig(store, {
				post: () => {
					calls++;
					return post();
				},
			});
			r.clock.t = T0 + HOUR;
			await r.tick();
			await r.tick();
			expect(calls).toBe(1);
			expect(r.events.filter((e) => e.event === "snooze-post-failed")).toHaveLength(1);
			expect(ranked(questionStates(store, r.clock.t).values()).map((i) => i.id)).toEqual(["Q-aaaa"]);
		}
	});
});

describe("a restart", () => {
	test("a snooze set before the daemon stopped is returned once by the daemon that starts after its time", async () => {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-snooze-eng-db-`);
		dirs.push(root);
		const first = openStore(dbPath(root));
		askQuestion(first, question("Q-aaaa"));
		snoozeQuestion(first, "Q-aaaa", iso(T0 + HOUR), T0);
		const before = rig(first);
		await before.tick();
		first.close();
		// the daemon was down when the time came
		const second = openStore(dbPath(root));
		const after = rig(second);
		after.clock.t = T0 + 5 * HOUR;
		await after.tick();
		await after.tick();
		expect(after.fake.posted.map((p) => p.item.id)).toEqual(["Q-aaaa"]);
		second.close();
		// and another restart does not show it a third time
		const third = openStore(dbPath(root));
		const again = rig(third);
		again.clock.t = T0 + 6 * HOUR;
		await again.tick();
		expect(again.fake.posted).toEqual([]);
		third.close();
	});
});
