/**
 * The rights record survives a daemon restart. Each "fresh daemon" here is a new openRightsSent on the same store,
 * which is exactly what daemon.ts does once at startup, followed by the same rightsFor call wakeRights makes.
 */
import { describe, expect, test } from "bun:test";
import { memStore } from "../testing/store.ts";
import { rightsUnchanged } from "./decide.ts";
import { fullStamp, invalidateRights, loadRightsSent, needsRights, openRightsSent, parseRightsSent, recordOf, RIGHTS_SENT_KEY, rightsFor, rightsFirstId, rightsFirstKey, rightsFirstMessage, rightsGap, rightsHash, rightsEpoch, rightsHighWater, rightsStamp, rightsStateKey, saveRightsSent, LEGACY_STAMP } from "./rights-sent.ts";
import type { Store } from "./store.ts";

const STEWARD = "steward-thread-1";
const RULES = "decision rights text\nR-1 a ruling";
const MANDATE = "";
const AT = "2026-11-13T18:00:00.000Z";
const FULL = `Decision rights (standing rules):\n${RULES}`;

/** One daemon process: the startup load, then one wake that lands. */
function daemonWake(store: Store, used: number | undefined, o: { steward?: string; rules?: string; mandate?: string; now?: string } = {}) {
	const ledger = openRightsSent(store);
	const r = rightsFor(ledger.get(), o.steward ?? STEWARD, o.rules ?? RULES, o.mandate ?? MANDATE, used, o.now ?? AT);
	ledger.set(r.record);
	return r.text;
}

describe("a restart keeps what was sent", () => {
	test("a fresh daemon with a matching record and no compaction sends the pointer", () => {
		const s = memStore();
		expect(daemonWake(s, 80_000)).toBe(FULL);
		expect(daemonWake(s, 90_000, { now: "2026-11-13T19:00:00.000Z" })).toBe(rightsUnchanged(AT));
	});
	test("unchanged rights are one line, and name when the full text went out, through further wakes and a restart", () => {
		const s = memStore();
		daemonWake(s, 80_000);
		const pointer = daemonWake(s, 90_000, { now: "2026-11-13T19:00:00.000Z" });
		expect(pointer.split("\n")).toHaveLength(1);
		expect(pointer).toContain(AT);
		expect(daemonWake(s, 95_000, { now: "2026-11-13T20:00:00.000Z" })).toBe(pointer);
	});
	test("an away mandate riding the wake, on or off, does not make the rulings count as changed", () => {
		const s = memStore();
		daemonWake(s, 80_000);
		expect(daemonWake(s, 90_000, { mandate: "- AFK MANDATE" })).toBe(`${rightsUnchanged(AT)}\n- AFK MANDATE`);
		expect(daemonWake(s, 91_000)).toBe(rightsUnchanged(AT));
	});
	test("a compaction while the daemon was down sends them in full", () => {
		const s = memStore();
		daemonWake(s, 80_000);
		expect(daemonWake(s, 40_000)).toBe(FULL);
	});
	test("changed rulings send them in full", () => {
		const s = memStore();
		daemonWake(s, 80_000);
		expect(daemonWake(s, 90_000, { rules: `${RULES}\nR-2 a new ruling`, now: "2026-11-13T19:00:00.000Z" })).toBe(`Decision rights (standing rules):\n${RULES}\nR-2 a new ruling`);
		// The new full text restarts the "since" time.
		expect(daemonWake(s, 95_000, { rules: `${RULES}\nR-2 a new ruling`, now: "2026-11-13T20:00:00.000Z" })).toBe(rightsUnchanged("2026-11-13T19:00:00.000Z"));
	});
	test("a different Steward thread sends them in full", () => {
		const s = memStore();
		daemonWake(s, 80_000);
		expect(daemonWake(s, 90_000, { steward: "steward-thread-2" })).toBe(FULL);
	});
	test("an unknown context size sends them in full", () => {
		const s = memStore();
		daemonWake(s, 80_000);
		expect(daemonWake(s, undefined)).toBe(FULL);
	});
	test("the high-water mark a running daemon keeps is what the next one compares to", () => {
		const s = memStore();
		daemonWake(s, 80_000);
		const ledger = openRightsSent(s);
		ledger.set(rightsHighWater(ledger.get(), 200_000));
		// 150k is above the last wake but below the mark: the context shrank since, so the Steward may have lost them.
		expect(daemonWake(s, 150_000)).toBe(FULL);
	});
});

describe("a record that can't be trusted sends them in full", () => {
	const seeded = () => { const s = memStore(); daemonWake(s, 80_000); return s; };
	test("missing", () => {
		const s = seeded();
		s.state.delete(RIGHTS_SENT_KEY);
		expect(daemonWake(s, 90_000)).toBe(FULL);
	});
	test("a stored value of the wrong shape", () => {
		const s = seeded();
		s.state.set(RIGHTS_SENT_KEY, { hash: "short" });
		expect(loadRightsSent(s)).toBeUndefined();
		expect(daemonWake(s, 90_000)).toBe(FULL);
	});
	test("well-formed JSON of the wrong shape", () => {
		for (const bad of [null, [], "x", { hash: 1 }, { hash: "short" }, { hash: rightsHash(STEWARD, RULES), used: "80000" }, { hash: rightsHash(STEWARD, RULES), used: -1 }])
			expect(parseRightsSent(bad)).toBeUndefined();
	});
});

describe("a reset survives a restart", () => {
	test("set back to undefined (a compaction sent, or a wake that did not land), the next daemon sends in full", () => {
		const s = memStore();
		daemonWake(s, 80_000);
		openRightsSent(s).set(undefined);
		// The row is never deleted: the reset bumps the epoch and drops the record in one write.
		expect(s.state.get(RIGHTS_SENT_KEY)).toEqual({ epoch: 1 });
		expect(daemonWake(s, 90_000)).toBe(FULL);
	});
	test("a shrink seen by the minute check clears the record", () => {
		const s = memStore();
		daemonWake(s, 80_000);
		const ledger = openRightsSent(s);
		ledger.set(rightsHighWater(ledger.get(), 30_000));
		expect(loadRightsSent(s)).toBeUndefined();
	});
});

describe("a database that refuses the write", () => {
	/** The real store with its state writes switched off, as a locked or full database would behave. */
	const refusing = (s: Store, on: { value: boolean }): Store => ({ ...s, state: { ...s.state, set: (k, v) => { if (on.value) throw Error("database is locked"); s.state.set(k, v); }, delete: (k) => { if (on.value) throw Error("database is locked"); s.state.delete(k); } } });

	test("a reset that fails is reported, and the record read back is the database's, never a copy in memory", () => {
		const s = memStore();
		daemonWake(s, 80_000);
		const refuse = { value: true };
		const errors: unknown[] = [];
		const ledger = openRightsSent(refusing(s, refuse), (e) => errors.push(e));
		ledger.set(undefined);
		expect(errors).toHaveLength(1);
		expect(ledger.get()).toEqual(loadRightsSent(s));
		refuse.value = false;
		ledger.set(undefined);
		expect(ledger.get()).toBeUndefined();
		expect(loadRightsSent(s)).toBeUndefined();
	});
	test("a record another writer (the relay) puts in the database is what the next read sees", () => {
		const s = memStore();
		const ledger = openRightsSent(s);
		expect(ledger.get()).toBeUndefined();
		saveRightsSent({ hash: rightsHash(STEWARD, RULES), steward: STEWARD, session: "s1" }, s);
		expect(ledger.get()).toEqual({ hash: rightsHash(STEWARD, RULES), steward: STEWARD, session: "s1" });
	});
});

describe("the record", () => {
	test("keeps when the full text last went out, and refuses an `at` that is not text", () => {
		const hash = rightsHash(STEWARD, RULES);
		expect(parseRightsSent({ hash, used: 1, at: AT })).toEqual({ hash, used: 1, at: AT });
		expect(parseRightsSent({ hash })).toEqual({ hash });
		expect(parseRightsSent({ hash, at: 5 })).toBeUndefined();
		expect(parseRightsSent({ hash, steward: STEWARD, session: "s1" })).toEqual({ hash, steward: STEWARD, session: "s1" });
		expect(parseRightsSent({ hash, session: 7 })).toBeUndefined();
	});
	test("is one state row holding the hash and the size", () => {
		const s = memStore();
		saveRightsSent({ hash: rightsHash(STEWARD, RULES), used: 80_000 }, s);
		expect(s.state.get(RIGHTS_SENT_KEY)).toEqual({ hash: rightsHash(STEWARD, RULES), used: 80_000 });
	});
});

describe("the durable record decides whether a row that depends on the rights may go", () => {
	const record = { hash: rightsHash(STEWARD, RULES), used: 80_000, at: AT };
	const now = { steward: STEWARD, session: "session-1", hash: record.hash };
	const held = { ...record, steward: STEWARD, session: "session-1" };
	test("a pointer stamp names the thread, the session, the hash and the pointer's time; a full stamp adds the size and proves the record", () => {
		expect(rightsStamp(record, STEWARD, "session-1")).toEqual({ steward: STEWARD, session: "session-1", hash: record.hash, at: AT });
		const full = fullStamp(record, STEWARD, "session-1");
		expect(full).toEqual({ steward: STEWARD, session: "session-1", hash: record.hash, at: AT, used: 80_000, full: true });
		expect(recordOf(full)).toEqual(held);
	});
	test("only a pointer or a legacy stamp makes a row depend on the record", () => {
		expect(needsRights(undefined)).toBe(false);
		expect(needsRights([fullStamp(record, STEWARD, "s")])).toBe(false);
		expect(needsRights([rightsStamp(record, STEWARD, "s")])).toBe(true);
		expect(needsRights([LEGACY_STAMP])).toBe(true);
		expect(needsRights([fullStamp(record, STEWARD, "s"), LEGACY_STAMP])).toBe(true);
	});
	test("it shows the state only for the same thread, session and hash", () => {
		expect(rightsGap(held, now)).toBeUndefined();
		expect(rightsGap(undefined, now)).toContain("no full-rights wake");
		expect(rightsGap(held, { ...now, steward: "steward-thread-2" })).toContain("Steward thread changed");
		expect(rightsGap(held, { ...now, session: "session-2" })).toContain("session changed");
		expect(rightsGap(held, { steward: STEWARD, hash: record.hash })).toContain("session changed");
		expect(rightsGap(held, { ...now, hash: rightsHash(STEWARD, `${RULES}\nR-2 new`) })).toContain("rulings changed");
		// A record written before the thread and session were kept never shows a state that has a session.
		expect(rightsGap(record, now)).toContain("Steward thread changed");
		expect(rightsGap(held, { steward: STEWARD, session: "session-1" })).toContain("cannot be read");
	});
	test("it shows the state only under the same epoch: a compaction or shrink since is a gap, and a new epoch is a new prerequisite id", () => {
		expect(rightsGap({ ...held, epoch: 2 }, { ...now, epoch: 2 })).toBeUndefined();
		expect(rightsGap({ ...held, epoch: 1 }, { ...now, epoch: 2 })).toContain("compaction or context shrink");
		expect(rightsGap(held, { ...now, epoch: 1 })).toContain("epoch 0 to 1");
		expect(rightsStateKey({ ...now, epoch: 0 })).toBe(rightsStateKey(now));
		expect(rightsStateKey({ ...now, epoch: 1 })).not.toBe(rightsStateKey(now));
	});
	test("the prerequisite's id is the row's and the state's: a new state is a new id, the same state the same id", () => {
		const k = rightsStateKey(now);
		expect(k).toMatch(/^[0-9a-f]{16}$/);
		expect(rightsStateKey({ ...now })).toBe(k);
		expect(rightsStateKey({ ...now, session: "session-2" })).not.toBe(k);
		expect(rightsStateKey({ ...now, hash: undefined })).not.toBe(k);
		expect(rightsFirstId("w1", k)).toBe(`w1:rights-first:${k}`);
		expect(rightsFirstId("w1", k, 2)).toBe(`w1:rights-first:${k}:2`);
		expect(rightsFirstKey(rightsFirstId("w1", k))).toBe(k);
		expect(rightsFirstKey(rightsFirstId("digest:abc", k, 3))).toBe(k);
		expect(rightsFirstKey("w1")).toBeUndefined();
	});
	test("the rights-first wake is standalone: the full block as given, the row it goes ahead of named", () => {
		const text = rightsFirstMessage("w1", FULL);
		expect(text.startsWith("[chamberlain] rights:")).toBe(true);
		expect(text).toContain("(w1)");
		expect(text.endsWith(`\n${FULL}`)).toBe(true);
		expect(rightsFirstMessage("w1", "rules cost $& and $1")).toContain("rules cost $& and $1");
	});
});

describe("the rights epoch", () => {
	const hash = rightsHash(STEWARD, RULES);
	test("starts at 0, rises by one on each invalidation, which drops the record in the same write and never deletes the row", () => {
		const s = memStore();
		expect(rightsEpoch(s)).toBe(0);
		saveRightsSent({ hash, steward: STEWARD, epoch: 0 }, s);
		expect(invalidateRights(s)).toBe(1);
		expect(s.state.get(RIGHTS_SENT_KEY)).toEqual({ epoch: 1 });
		expect(loadRightsSent(s)).toBeUndefined();
		expect(invalidateRights(s)).toBe(2);
		expect(rightsEpoch(s)).toBe(2);
	});
	test("a record for an older epoch is never stored over a newer one", () => {
		const s = memStore();
		invalidateRights(s);
		saveRightsSent({ hash, steward: STEWARD, epoch: 0 }, s);
		expect(s.state.get(RIGHTS_SENT_KEY)).toEqual({ epoch: 1 });
		saveRightsSent({ hash, steward: STEWARD, epoch: 1 }, s);
		expect(loadRightsSent(s)).toEqual({ hash, steward: STEWARD, epoch: 1 });
	});
	test("an epoch that is not a whole number of 0 or more makes the record untrusted, and reads as 0", () => {
		for (const epoch of [-1, 1.5, "1", null]) expect(parseRightsSent({ hash, epoch })).toBeUndefined();
		const s = memStore();
		s.state.set(RIGHTS_SENT_KEY, { epoch: "7" });
		expect(rightsEpoch(s)).toBe(0);
	});
	test("a full stamp carries the epoch it was composed under, and the record it proves keeps it", () => {
		const { record } = rightsFor(undefined, STEWARD, RULES, "", 10, AT, 3);
		const full = fullStamp(record, STEWARD, "s1");
		expect(full.epoch).toBe(3);
		expect(recordOf(full).epoch).toBe(3);
		expect(rightsStamp(record, STEWARD, "s1").epoch).toBe(3);
	});
});
