/** sqlite-store, continued: see sqlite-store.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { useCoreSqliteStoreFixtures } from "../testing/core-sqlite-store-fixtures.ts";
import { NOTIFY_ONCE, repeatAtIntervals, repeatEvery } from "./notification.ts";
import type { Store } from "./store.ts";

const { mem } = useCoreSqliteStoreFixtures();

describe("items: observe, the repeat policy and the lifecycle", () => {
	const obs = (s: Store, o: Partial<Parameters<Store["items"]["observe"]>[0]> = {}) =>
		s.items.observe({ source: "sweep:disk", kind: "finding", dedupKey: "disk-low", ...o });

	test("a new item is triggered, notifies once under the default policy, and a second sighting does not notify again", () => {
		const s = mem();
		const a = obs(s, { now: 100, subject: { kind: "pr", id: "42" }, payload: { text: "disk" } });
		expect(a).toMatchObject({ created: true, notify: true, wouldNotify: false });
		expect(a.item).toMatchObject({
			status: "triggered",
			mode: "live",
			firstSeen: 100,
			lastSeen: 100,
			notificationCount: 1,
			nextNotificationAt: null,
			subject: { kind: "pr", id: "42" },
			payload: { text: "disk" },
		});
		const b = obs(s, { now: 200 });
		expect(b).toMatchObject({ created: false, notify: false });
		expect(b.item).toMatchObject({ firstSeen: 100, lastSeen: 200, notificationCount: 1, payload: { text: "disk" } });
	});

	test("(source, dedup key) is unique: the same dedup key in another source is another item", () => {
		const s = mem();
		obs(s, { now: 1 });
		obs(s, { source: "sweep:net", now: 1 });
		expect(s.items.list()).toHaveLength(2);
		obs(s, { now: 2 });
		expect(s.items.list()).toHaveLength(2);
	});

	test("a repeating item notifies again when its time comes, up to the maximum", () => {
		const s = mem();
		const policy = repeatAtIntervals([1000], 3);
		const sent = [0, 500, 1000, 1500, 2000, 3000, 4000].map((now) => obs(s, { repeat: policy, now }).notify);
		expect(sent).toEqual([true, false, true, false, true, false, false]);
		expect(s.items.get("sweep:disk", "disk-low")).toMatchObject({ notificationCount: 3, nextNotificationAt: null });
	});

	test("a baseline item is learned silently, and stays quiet until it goes away and comes back", () => {
		const s = mem();
		const r = obs(s, { baseline: true, repeat: repeatEvery(0), now: 1 });
		expect(r).toMatchObject({ created: true, notify: false });
		expect(r.item.status).toBe("acknowledged");
		expect(obs(s, { repeat: repeatEvery(0), now: 2 }).notify).toBe(false);
		s.items.resolveAbsent("sweep:disk", "finding", [], 3);
		expect(s.items.get("sweep:disk", "disk-low")?.status).toBe("resolved");
		const back = obs(s, { repeat: NOTIFY_ONCE, now: 4 });
		expect(back).toMatchObject({ reopened: true, notify: true });
		expect(back.item).toMatchObject({ firstSeen: 4, notificationCount: 1, resolvedAt: null });
	});

	test("resolveAbsent resolves only what is missing, in its source and kind", () => {
		const s = mem();
		for (const key of ["a", "b", "c"]) obs(s, { dedupKey: key, now: 1 });
		s.items.observe({ source: "sweep:disk", kind: "other", dedupKey: "z", now: 1 });
		const gone = s.items.resolveAbsent("sweep:disk", "finding", ["b"], 5);
		expect(gone.map((i) => i.dedupKey)).toEqual(["a", "c"]);
		expect(s.items.list({ status: "resolved" }).map((i) => i.dedupKey)).toEqual(["a", "c"]);
		expect(s.items.get("sweep:disk", "z")?.status).not.toBe("resolved");
	});

	test("shadow mode records would-be notifications apart from live ones, so going live starts from a true zero", () => {
		const s = mem();
		const policy = repeatEvery(1000);
		expect(obs(s, { mode: "shadow", repeat: policy, now: 0 })).toMatchObject({ notify: false, wouldNotify: true });
		expect(obs(s, { mode: "shadow", repeat: policy, now: 1000 })).toMatchObject({ notify: false, wouldNotify: true });
		const logged = s.items.get("sweep:disk", "disk-low")!;
		expect(logged).toMatchObject({
			status: "triggered",
			notificationCount: 0,
			nextNotificationAt: null,
			shadowNotificationCount: 2,
		});
		// Going live: the first real notification is count 1 now, not a continuation of two would-be ones.
		const live = obs(s, { mode: "live", repeat: policy, now: 1100 });
		expect(live).toMatchObject({ notify: true, wouldNotify: false });
		expect(live.item).toMatchObject({ status: "triggered", notificationCount: 1, shadowNotificationCount: 2 });
	});

	test("mode silenced tracks the item and never notifies or would-notify", () => {
		const s = mem();
		expect(obs(s, { mode: "silenced", now: 1 })).toMatchObject({
			notify: false,
			wouldNotify: false,
			item: { notificationCount: 0, shadowNotificationCount: 0 },
		});
		expect(obs(s, { mode: "silenced", now: 2 }).item.lastSeen).toBe(2);
	});

	test("acknowledge, resolve and patch change state and payload only, never the notification columns", () => {
		const s = mem();
		obs(s, { repeat: repeatEvery(10), now: 0, payload: { a: 1 } });
		expect(s.items.acknowledge("sweep:disk", "disk-low", 5, { note: "seen" })?.status).toBe("acknowledged");
		expect(obs(s, { repeat: repeatEvery(10), now: 50 }).notify).toBe(false);
		expect(s.items.patch("sweep:disk", "disk-low", { b: 2 })?.payload).toEqual({ a: 1, note: "seen", b: 2 });
		const done = s.items.resolve("sweep:disk", "disk-low", 60, { how: "fixed" })!;
		expect(done).toMatchObject({
			status: "resolved",
			resolvedAt: 60,
			notificationCount: 1,
			payload: { a: 1, note: "seen", b: 2, how: "fixed" },
		});
		expect(s.items.resolve("sweep:disk", "disk-low", 99)?.resolvedAt).toBe(60);
		expect(s.items.resolve("sweep:disk", "nope")).toBeUndefined();
	});

	test("prune deletes old resolved items, but not the queue's", () => {
		const s = mem();
		for (const source of ["sweep:x", "queue"]) {
			s.items.observe({ source, kind: "k", dedupKey: "a", now: 1 });
			s.items.resolve(source, "a", 2);
		}
		s.items.observe({ source: "sweep:x", kind: "k", dedupKey: "live", now: 1 });
		expect(s.items.prune(1000)).toBe(1);
		expect(s.items.list().map((i) => `${i.source}/${i.dedupKey}`)).toEqual(["queue/a", "sweep:x/live"]);
	});

	test("list filters by source, kind, status and subject", () => {
		const s = mem();
		s.items.observe({ source: "a", kind: "finding", dedupKey: "1", subject: { kind: "pr", id: "7" } });
		s.items.observe({ source: "a", kind: "alarm", dedupKey: "2" });
		s.items.observe({ source: "b", kind: "finding", dedupKey: "3", subject: { kind: "pr", id: "7" } });
		expect(s.items.list({ source: "a" })).toHaveLength(2);
		expect(s.items.list({ kind: "finding" })).toHaveLength(2);
		expect(s.items.list({ subject: { kind: "pr", id: "7" } }).map((i) => i.dedupKey)).toEqual(["1", "3"]);
		expect(s.items.list({ status: ["triggered"] })).toHaveLength(3);
		expect(s.items.list({ status: "resolved" })).toHaveLength(0);
	});
});

describe("claims: the one-wake ledger", () => {
	const claim = (o: Partial<Parameters<Store["claims"]["claim"]>[1]> = {}) => ({
		owner: "page",
		item: "Q-aaaa1",
		deliveryId: "answer:item:Q-aaaa1",
		message: "the wake",
		t: "2026-11-12T10:00:00.000Z",
		answer: { choice: 0 },
		...o,
	});

	test("the first claim wins and the item itself is untouched; every later claimant gets the winner's back", () => {
		const s = mem();
		s.items.observe({ source: "queue", kind: "question", dedupKey: "Q-aaaa1", mode: "silenced" });
		const first = s.claims.claim("queue", claim());
		const second = s.claims.claim("queue", claim({ owner: "daemon", deliveryId: "other", message: "another" }));
		expect(first.won).toBe(true);
		expect(second).toMatchObject({
			won: false,
			claim: { owner: "page", deliveryId: "answer:item:Q-aaaa1", message: "the wake", answer: { choice: 0 } },
		});
		expect(s.items.get("queue", "Q-aaaa1")?.status).toBe("triggered");
		expect(s.claims.get("queue", "Q-aaaa1")?.message).toBe("the wake");
		expect(s.claims.list("queue")).toHaveLength(1);
	});

	test("a delivery id taken by another item is an error, never a quietly lost claim", () => {
		const s = mem();
		for (const k of ["Q-aaaa1", "Q-bbbb2"])
			s.items.observe({ source: "queue", kind: "question", dedupKey: k, mode: "silenced" });
		s.claims.claim("queue", claim());
		expect(() => s.claims.claim("queue", claim({ item: "Q-bbbb2" }))).toThrow(/UNIQUE/);
		expect(s.claims.get("queue", "Q-bbbb2")).toBeUndefined();
		expect(s.items.get("queue", "Q-bbbb2")?.status).toBe("triggered");
	});

	test("a claim made inside a transaction that rolls back leaves no claim", () => {
		const s = mem();
		s.items.observe({ source: "queue", kind: "question", dedupKey: "Q-aaaa1", mode: "silenced" });
		expect(() =>
			s.tx(() => {
				s.claims.claim("queue", claim());
				throw Error("crash before commit");
			}),
		).toThrow();
		expect(s.claims.get("queue", "Q-aaaa1")).toBeUndefined();
		expect(s.items.get("queue", "Q-aaaa1")?.status).toBe("triggered");
	});

	test("the direct send is taken once, ever, and records how it ended", () => {
		const s = mem();
		s.items.observe({ source: "queue", kind: "question", dedupKey: "Q-aaaa1" });
		expect(s.claims.readRelay("queue", "Q-aaaa1")).toEqual({ started: false });
		expect(s.claims.startRelay("queue", "Q-aaaa1")).toBe(true);
		expect(s.claims.startRelay("queue", "Q-aaaa1")).toBe(false);
		expect(s.claims.readRelay("queue", "Q-aaaa1")).toEqual({ started: true });
		s.claims.finishRelay("queue", "Q-aaaa1", { outcome: "delivered", detail: "ok" });
		expect(s.claims.readRelay("queue", "Q-aaaa1")).toMatchObject({ started: true, outcome: "delivered", detail: "ok" });
		expect(s.claims.listRelays("queue").get("Q-aaaa1")?.t).toBeTruthy();
	});

	test("evidence rows point at files and come back in order", () => {
		const s = mem();
		s.items.observe({ source: "queue", kind: "question", dedupKey: "Q-aaaa1" });
		s.evidence.put("queue", "Q-aaaa1", [
			{ type: "image", name: "a.png", caption: "before" },
			{ type: "link", url: "https://example.com/x" },
		]);
		expect(s.evidence.list("queue", "Q-aaaa1")).toEqual([
			{ type: "image", name: "a.png", caption: "before" },
			{ type: "link", url: "https://example.com/x" },
		]);
		s.evidence.put("queue", "Q-aaaa1", []);
		expect(s.evidence.list("queue", "Q-aaaa1")).toEqual([]);
	});
});
