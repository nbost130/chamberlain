import { describe, expect, test } from "bun:test";
import { memStore } from "../testing/store.ts";
import { deliveredRow } from "../testing/relay.ts";
import { EVENT_KEEP_MS, ITEM_KEEP_MS, maintain } from "./maintain.ts";

const DAY = 24 * 3600_000;
const NOW = Date.parse("2026-11-12T12:00:00Z");

describe("maintain", () => {
	test("forgets old deliveries, ages out wake and alarm items, deletes old resolved items, and keeps the queue's", () => {
		const s = memStore();
		deliveredRow(s, "old", NOW);
		deliveredRow(s, "new", NOW);
		deliveredRow(s, "ancient", NOW - 31 * DAY);
		// An old wake record that was never resolved, a recent one, an old resolved finding, and an old answered question.
		s.items.observe({ source: "notification-log", kind: "sent", dedupKey: "old-key", now: NOW - ITEM_KEEP_MS - DAY });
		s.items.observe({ source: "notification-log", kind: "sent", dedupKey: "new-key", now: NOW - DAY });
		s.items.observe({ source: "check:a", kind: "finding", dedupKey: "gone", now: NOW - 40 * DAY });
		s.items.resolve("check:a", "gone", NOW - 40 * DAY);
		s.items.observe({ source: "queue", kind: "question", dedupKey: "Q-aaaa1", mode: "silenced", now: NOW - 40 * DAY });
		s.items.resolve("queue", "Q-aaaa1", NOW - 40 * DAY);
		s.events.append({ t: new Date(NOW - EVENT_KEEP_MS - DAY).toISOString(), event: "fire" });
		s.events.append({ t: new Date(NOW - DAY).toISOString(), event: "fire" });

		const r = maintain(s, NOW);
		expect(r).toEqual({ delivered: 1, resolved: 1, items: 2, events: 1, challenges: 0 });
		// The row is gone; the id is not (migration 7's tombstone), so it can never be queued again.
		expect(s.wakes.rows("all").map((w) => w.deliveryId)).toEqual(["old", "new"]);
		expect([s.wakes.isDelivered("ancient"), s.wakes.isDelivered("new")]).toEqual([true, true]);
		expect(s.items.list().map((i) => `${i.source}/${i.dedupKey}`)).toEqual([
			"notification-log/new-key",
			"queue/Q-aaaa1",
		]);
		expect(s.events.count()).toBe(1);
		// Idempotent.
		expect(maintain(s, NOW)).toEqual({ delivered: 0, resolved: 0, items: 0, events: 0, challenges: 0 });
	});

	test("prunes confirmation challenges that expired or were used more than a day ago, and keeps a live one", () => {
		const s = memStore();
		const c = (id: string, expiresAt: number) => ({
			tokenHash: id,
			cardId: `C-${id}`,
			sig: "s",
			choice: 0,
			sessionHash: "h",
			issuedAt: expiresAt - 60_000,
			expiresAt,
		});
		s.challenges.issue(c("old", NOW - 3 * DAY));
		s.challenges.issue(c("live", NOW + 30_000));
		s.challenges.issue(c("spent", NOW + 30_000));
		s.challenges.consume("spent", { cardId: "C-spent", sig: "s", choice: 0, sessionHash: "h" }, NOW - 2 * DAY);
		expect(maintain(s, NOW).challenges).toBe(2);
		expect(s.challenges.consume("live", { cardId: "C-live", sig: "s", choice: 0, sessionHash: "h" }, NOW)).toBe("ok");
	});
});
