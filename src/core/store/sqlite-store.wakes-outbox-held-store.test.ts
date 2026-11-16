/** sqlite-store, continued: see sqlite-store.test.ts for the overview. */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { useCoreSqliteStoreFixtures } from "../../testing/core-sqlite-store-fixtures.ts";
import { openStore } from "./sqlite-store.ts";
import type { Challenge } from "./store-wakes.ts";

const { mem } = useCoreSqliteStoreFixtures();

describe("wakes: the outbox and the held store", () => {
	test("enqueue binds the row's own id; hold keeps an item unbound; either refuses an id that is held or bound to any row", () => {
		const s = mem();
		expect(s.wakes.enqueue({ deliveryId: "a", message: "m", queuedAt: 1, kind: "turn_ended", thread: "t" })).toBe(true);
		expect(s.wakes.enqueue({ deliveryId: "a", message: "other", queuedAt: 2 })).toBe(false);
		expect(s.wakes.hold({ deliveryId: "a", message: "m", queuedAt: 2 })).toBe(false);
		expect(s.wakes.hold({ deliveryId: "h1", message: "m", queuedAt: 3, kind: "sweep" })).toBe(true);
		expect(s.wakes.enqueue({ deliveryId: "h1", message: "m", queuedAt: 3 })).toBe(false);
		expect(s.wakes.rows()).toMatchObject([
			{
				deliveryId: "a",
				message: "m",
				kind: "turn_ended",
				thread: "t",
				status: "pending",
				attempts: 0,
				members: [{ deliveryId: "a", queuedAt: 1, kind: "turn_ended", thread: "t" }],
			},
		]);
		expect(s.wakes.held()).toEqual([{ deliveryId: "h1", message: "m", queuedAt: 3, kind: "sweep" }]);
		expect([s.wakes.known("a"), s.wakes.known("h1"), s.wakes.known("nope")]).toEqual([true, true, false]);
	});

	test("compose freezes one row from the held items in one transaction; a compose that throws leaves them held", () => {
		const s = mem();
		s.wakes.hold({ deliveryId: "h1", message: "a", queuedAt: 1 });
		s.wakes.hold({ deliveryId: "h2", message: "b", queuedAt: 2 });
		expect(() =>
			s.wakes.compose(5, () => {
				throw Error("crash");
			}),
		).toThrow();
		expect(s.wakes.held().map((h) => h.deliveryId)).toEqual(["h1", "h2"]);
		const row = s.wakes.compose(5, (held) => ({
			deliveryId: "digest:x",
			message: held.map((h) => h.message).join("+"),
			folded: 0,
			members: held.map((h) => h.deliveryId),
			kind: "digest",
		}))!;
		expect(row).toMatchObject({ deliveryId: "digest:x", message: "a+b", createdAt: 5, status: "pending" });
		expect(row.members.map((m) => m.deliveryId)).toEqual(["h1", "h2"]);
		expect(s.wakes.held()).toEqual([]);
		expect(s.wakes.find("h2")!.id).toBe(row.id);
		expect(
			s.wakes.compose(6, () => {
				throw Error("never called");
			}),
		).toBeUndefined();
	});

	test("attempts count only on a pending row; finish, retry and cancel move only the states they name", () => {
		const s = mem();
		s.wakes.enqueue({ deliveryId: "a", message: "m", queuedAt: 1 });
		const id = s.wakes.find("a")!.id;
		expect([s.wakes.beginAttempt(id, 2), s.wakes.beginAttempt(id, 3)]).toEqual([1, 2]);
		expect(s.wakes.retry("a")).toBe("pending");
		expect(s.wakes.find("a")!.attempts).toBe(2);
		expect(s.wakes.finish(id, "dead_letter", 4)).toBe(true);
		expect(s.wakes.beginAttempt(id, 5)).toBeUndefined();
		expect(s.wakes.retry("a")).toBe("dead_letter");
		expect(s.wakes.find("a")).toMatchObject({ status: "pending", attempts: 0 });
		expect(s.wakes.finish(id, "delivered", 6)).toBe(true);
		expect(s.wakes.isDelivered("a")).toBe(true);
		expect(s.wakes.finish(id, "dead_letter", 7)).toBe(false);
		expect(s.wakes.cancel("a", 8)).toBe("delivered");
		expect(s.wakes.find("a")!.status).toBe("delivered");
		expect(s.wakes.retry("nope")).toBeUndefined();
	});

	test("prune deletes delivered and cancelled rows finished before the cut, and no other", () => {
		const s = mem();
		for (const id of ["old", "new", "dead", "pending", "gone"])
			s.wakes.enqueue({ deliveryId: id, message: "m", queuedAt: 1 });
		const row = (id: string) => s.wakes.find(id)!.id;
		s.wakes.finish(row("old"), "delivered", 1);
		s.wakes.finish(row("new"), "delivered", 100);
		s.wakes.finish(row("dead"), "dead_letter", 1);
		s.wakes.cancel("gone", 1);
		// Steward-lane delivered rows prune only when ledgered discharged/unrecoverable (B2).
		s.steward.insertLedger({ outboxId: row("old"), gen: 1, origin: "unrecoverable" });
		s.steward.insertLedger({ outboxId: row("new"), gen: 1, origin: "unrecoverable" });
		expect(s.wakes.prune(50)).toBe(2);
		expect(s.wakes.rows("all").map((r) => r.deliveryId)).toEqual(["new", "dead", "pending"]);
		// The rows are gone, the ids are not: a tombstone per delivered or cancelled id outlives retention.
		expect([s.wakes.known("old"), s.wakes.known("gone"), s.wakes.known("never")]).toEqual([true, true, false]);
		expect(s.wakes.isDelivered("old")).toBe(true);
		expect(s.wakes.isDelivered("gone")).toBe(false);
	});
});

describe("events, state, rulings, butlers, away, decisions", () => {
	test("the event log is queried with SQL filters and returns the line it was given", () => {
		const s = mem();
		s.events.append({ t: "2026-11-12T10:00:00.000Z", event: "fire", src: "queue-web", thread: "t1" });
		s.events.append({ t: "2026-11-12T11:00:00.000Z", event: "delivered", deliveryId: "d", queuedAt: 5 });
		s.events.append({ t: "2026-11-12T12:00:00.000Z", event: "alarm", dedupKey: "k" });
		expect(s.events.query({ events: ["delivered"] })).toEqual([
			{ t: "2026-11-12T11:00:00.000Z", event: "delivered", deliveryId: "d", queuedAt: 5 },
		]);
		expect(s.events.query({ since: "2026-11-12T10:30:00.000Z" }).map((e) => e.event)).toEqual(["delivered", "alarm"]);
		expect(s.events.query({ src: "queue-web" })[0]).toMatchObject({ event: "fire", thread: "t1" });
		expect(s.events.count({ events: ["fire", "alarm"] })).toBe(2);
		expect(s.events.query({ limit: 1 })).toHaveLength(1);
		expect(s.events.prune("2026-11-12T11:30:00.000Z")).toBe(2);
		expect(s.events.count()).toBe(1);
	});

	test("an imported event is stored once however often it is imported", () => {
		const s = mem();
		for (let i = 0; i < 3; i++) s.events.append({ t: "2026-11-12T10:00:00.000Z", event: "fire" }, "hash-1");
		expect(s.events.count()).toBe(1);
	});

	test("state is read-modify-written in one transaction, and undefined deletes", () => {
		const s = mem();
		expect(s.state.update<number>("n", (n) => (n ?? 0) + 1)).toBe(1);
		expect(s.state.update<number>("n", (n) => (n ?? 0) + 1)).toBe(2);
		expect(s.state.update("n", () => undefined)).toBeUndefined();
		expect(s.state.get("n")).toBeUndefined();
	});

	test("rulings round trip with their history, and an id is unique", () => {
		const s = mem();
		const r = {
			id: "R3",
			date: "2026-11-12",
			words: "w",
			decides: "d",
			source: "chat" as const,
			status: "in-force" as const,
			confirmed: true,
			confirmedAt: "t",
			history: [{ t: "t", what: "x" }],
		};
		s.rulings.save(r);
		s.rulings.save({ ...r, id: "R10", decides: "later" });
		s.rulings.save({ ...r, decides: "edited" });
		expect(s.rulings.list().map((x) => [x.id, x.decides])).toEqual([
			["R3", "edited"],
			["R10", "later"],
		]);
		expect(s.rulings.list()[0]).toEqual({ ...r, decides: "edited" });
	});

	test("butlers: insert refuses a repeat id, stop is once", () => {
		const s = mem();
		const b = { id: "B-1", thread: "t", machine: "m", model: "x", scope: "s", started: "2026-11-12T10:00:00.000Z" };
		expect(s.butlers.insert(b)).toBe(true);
		expect(s.butlers.insert(b)).toBe(false);
		expect(s.butlers.stop("B-1", "2026-11-12T11:00:00.000Z", "done")).toBe(true);
		expect(s.butlers.stop("B-1", "later")).toBe(false);
		expect(s.butlers.get("B-1")).toEqual({ ...b, stopped: "2026-11-12T11:00:00.000Z", reason: "done" });
	});

	test("away: one current absence; entering again closes the old one, exit returns it", () => {
		const s = mem();
		expect(s.away.current()).toBeUndefined();
		s.away.enter({ enteredAt: "2026-11-12T10:00:00.000Z", words: "back at five" });
		s.away.enter({
			enteredAt: "2026-11-12T11:00:00.000Z",
			words: "later",
			expectedReturn: "tomorrow",
			spendNote: "none",
		});
		expect(s.away.current()).toEqual({
			enteredAt: "2026-11-12T11:00:00.000Z",
			words: "later",
			expectedReturn: "tomorrow",
			spendNote: "none",
		});
		expect(s.away.exit("x")?.words).toBe("later");
		expect(s.away.current()).toBeUndefined();
		expect(s.away.exit("y")).toBeUndefined();
	});

	test("decisions append and list with their ruling ids", () => {
		const s = mem();
		s.decisions.append({ t: "1", thread: "a", decision: "d", ruling: "R1: why", rulingIds: ["R1"], ref: null });
		s.decisions.append({ t: "2", thread: "b", decision: "e", ruling: "free text", ref: "x" });
		expect(s.decisions.list()).toEqual([
			{ t: "1", thread: "a", decision: "d", ruling: "R1: why", rulingIds: ["R1"], ref: null },
			{ t: "2", thread: "b", decision: "e", ruling: "free text", ref: "x" },
		]);
	});
});

describe("confirmation challenges", () => {
	const c = (over: Partial<Challenge> = {}): Challenge => ({
		tokenHash: "h1",
		cardId: "C-1",
		sig: "s",
		choice: 0,
		sessionHash: "sess",
		issuedAt: 100,
		expiresAt: 160,
		...over,
	});
	const want = { cardId: "C-1", sig: "s", choice: 0, sessionHash: "sess" };
	test("consumed once, and only for exactly what it was issued for; a refusal changes nothing", () => {
		const s = openStore(":memory:");
		s.challenges.issue(c());
		expect(s.challenges.consume("nope", want, 120)).toBe("unknown");
		for (const bad of [{ cardId: "C-2" }, { sig: "t" }, { choice: 1 }, { sessionHash: "other" }])
			expect(s.challenges.consume("h1", { ...want, ...bad }, 120)).toBe("mismatch");
		expect(s.challenges.consume("h1", want, 160)).toBe("expired");
		expect(s.challenges.consume("h1", want, 159)).toBe("ok");
		expect(s.challenges.consume("h1", want, 159)).toBe("used");
	});
	test("a new challenge for the same card and session replaces the unconsumed one, but not another session's, nor a consumed one", () => {
		const s = openStore(":memory:");
		s.challenges.issue(c());
		s.challenges.issue(c({ tokenHash: "other-session", sessionHash: "s2" }));
		s.challenges.issue(c({ tokenHash: "h2" }));
		expect(s.challenges.consume("h1", want, 120)).toBe("unknown");
		expect(s.challenges.consume("other-session", { ...want, sessionHash: "s2" }, 120)).toBe("ok");
		expect(s.challenges.consume("h2", want, 120)).toBe("ok");
		s.challenges.issue(c({ tokenHash: "h3" }));
		expect(s.challenges.consume("h2", want, 121)).toBe("used");
	});
	test("pruning removes only expired and consumed ones", () => {
		const s = openStore(":memory:");
		s.challenges.issue(c({ tokenHash: "live", cardId: "C-live", expiresAt: 10_000 }));
		s.challenges.issue(c({ tokenHash: "dead", cardId: "C-dead", expiresAt: 50 }));
		s.challenges.issue(c({ tokenHash: "spent", cardId: "C-spent", expiresAt: 10_000 }));
		s.challenges.consume("spent", { ...want, cardId: "C-spent" }, 60);
		expect(s.challenges.prune(1000)).toBe(2);
		expect(s.challenges.consume("live", { ...want, cardId: "C-live" }, 1001)).toBe("ok");
		expect(s.challenges.consume("dead", want, 1001)).toBe("unknown");
	});
});

describe("the sequence (migration 12): durable and monotonic, never the clock", () => {
	test("next() only rises, survives a reopen, and the table refuses a second row, a delete and any update that does not raise it", () => {
		const dir = mkdtempSync(`${tmpdir()}/chamberlain-seq-`);
		const s1 = openStore(`${dir}/chamberlain.db`);
		expect(s1.sequence.current()).toBe(0);
		expect([s1.sequence.next(), s1.sequence.next(), s1.sequence.next()]).toEqual([1, 2, 3]);
		s1.close();
		const s2 = openStore(`${dir}/chamberlain.db`);
		expect(s2.sequence.next()).toBe(4);
		s2.close();
		const db = new Database(`${dir}/chamberlain.db`);
		expect(() => db.exec("INSERT INTO store_sequence (id, value) VALUES (2, 9)")).toThrow();
		expect(() => db.exec("DELETE FROM store_sequence")).toThrow("exactly one row");
		expect(() => db.exec("UPDATE store_sequence SET value = 1")).toThrow("only increases");
		expect(() => db.exec("UPDATE store_sequence SET value = 4")).toThrow("only increases");
		db.close();
		rmSync(dir, { recursive: true, force: true });
	});
	test("a value taken inside a transaction that rolls back is not kept: the next one is not lower than any committed value", () => {
		const s = openStore(":memory:");
		s.sequence.next();
		expect(() =>
			s.tx(() => {
				s.sequence.next();
				throw Error("abort");
			}),
		).toThrow("abort");
		expect(s.sequence.next()).toBe(2);
		s.close();
	});
});
