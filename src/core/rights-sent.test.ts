/**
 * The rights record survives a daemon restart. Each "fresh daemon" here is a new openRightsSent on the same store,
 * which is exactly what daemon.ts does once at startup, followed by the same rightsFor call wakeRights makes.
 */
import { describe, expect, test } from "bun:test";
import { memStore } from "../testing/store.ts";
import { RIGHTS_UNCHANGED } from "./decide.ts";
import { loadRightsSent, openRightsSent, parseRightsSent, RIGHTS_SENT_KEY, rightsFor, rightsHash, rightsHighWater, saveRightsSent } from "./rights-sent.ts";
import type { Store } from "./store.ts";

const STEWARD = "steward-thread-1";
const RULES = "decision rights text\nR-1 a ruling";
const MANDATE = "";
const FULL = `Decision rights (standing rules):\n${RULES}`;

/** One daemon process: the startup load, then one wake that lands. */
function daemonWake(store: Store, used: number | undefined, o: { steward?: string; rules?: string } = {}) {
	const ledger = openRightsSent(store);
	const r = rightsFor(ledger.get(), o.steward ?? STEWARD, o.rules ?? RULES, MANDATE, used);
	ledger.set(r.record);
	return r.text;
}

describe("a restart keeps what was sent", () => {
	test("a fresh daemon with a matching record and no compaction sends the pointer", () => {
		const s = memStore();
		expect(daemonWake(s, 80_000)).toBe(FULL);
		expect(daemonWake(s, 90_000)).toBe(RIGHTS_UNCHANGED);
	});
	test("a compaction while the daemon was down sends them in full", () => {
		const s = memStore();
		daemonWake(s, 80_000);
		expect(daemonWake(s, 40_000)).toBe(FULL);
	});
	test("changed rulings send them in full", () => {
		const s = memStore();
		daemonWake(s, 80_000);
		expect(daemonWake(s, 90_000, { rules: `${RULES}\nR-2 a new ruling` })).toBe(`Decision rights (standing rules):\n${RULES}\nR-2 a new ruling`);
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
		for (const bad of [null, [], "x", { hash: 1 }, { hash: "short" }, { hash: rightsHash(STEWARD, RULES, MANDATE), used: "80000" }, { hash: rightsHash(STEWARD, RULES, MANDATE), used: -1 }])
			expect(parseRightsSent(bad)).toBeUndefined();
	});
});

describe("a reset survives a restart", () => {
	test("set back to undefined (a compaction sent, or a wake that did not land), the next daemon sends in full", () => {
		const s = memStore();
		daemonWake(s, 80_000);
		openRightsSent(s).set(undefined);
		expect(s.state.get(RIGHTS_SENT_KEY)).toBeUndefined();
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

	test("a reset that fails is reported, and retried by the next minute's set even though memory already matches", () => {
		const s = memStore();
		daemonWake(s, 80_000);
		const refuse = { value: true };
		const errors: unknown[] = [];
		const ledger = openRightsSent(refusing(s, refuse), (e) => errors.push(e));
		ledger.set(undefined);
		expect(errors).toHaveLength(1);
		expect(ledger.get()).toBeUndefined();
		expect(loadRightsSent(s)).toBeDefined();
		// The minute check, once the database takes writes again: memory is already undefined, so only the retry flag sends it on.
		refuse.value = false;
		ledger.set(rightsHighWater(ledger.get(), 90_000));
		expect(loadRightsSent(s)).toBeUndefined();
		expect(errors).toHaveLength(1);
	});
});

describe("the record", () => {
	test("is one state row holding the hash and the size", () => {
		const s = memStore();
		saveRightsSent({ hash: rightsHash(STEWARD, RULES, MANDATE), used: 80_000 }, s);
		expect(s.state.get(RIGHTS_SENT_KEY)).toEqual({ hash: rightsHash(STEWARD, RULES, MANDATE), used: 80_000 });
	});
});
