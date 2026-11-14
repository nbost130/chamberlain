/** obs, continued: see obs.test.ts for the overview. */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { useCoreObsObsFixtures } from "../../testing/core-obs-obs-fixtures.ts";
import { eventRows, memObs } from "../../testing/obs.ts";
import { memStore } from "../../testing/store.ts";
import { logFor, obsFor } from "../log.ts";
import { openStore } from "../sqlite-store.ts";
import { makeLogger } from "./logger.ts";

const { scratch } = useCoreObsObsFixtures();

describe("the dual write is off the caller's path", () => {
	test("a log call only queues its old-table line: nothing is written until the call has returned, and then in one transaction", async () => {
		const dir = scratch();
		const store = openStore(`${dir}/chamberlain.db`);
		const writes: number[] = [];
		const real = store.events.tryAppendMany.bind(store.events);
		store.events.tryAppendMany = (lines) => {
			writes.push(lines.length);
			return real(lines);
		};
		const log = logFor(store);
		for (let i = 0; i < 50; i++) log("fire", { kind: "failed", n: i });
		expect(writes).toEqual([]);
		await Promise.resolve();
		expect(writes).toEqual([50]);
		const raw = new Database(`${dir}/chamberlain.db`, { readonly: true });
		expect((raw.query("SELECT COUNT(*) AS n FROM events WHERE event = 'fire'").get() as { n: number }).n).toBe(50);
		raw.close();
		store.close();
	});

	test("a process reads its own lines at once, without waiting for the microtask", () => {
		const store = memStore();
		logFor(store)("start", { dry: false });
		expect(store.events.count()).toBe(1);
		expect(store.events.query().map((e) => e.event)).toEqual(["start"]);
		store.close();
	});

	test("a ledger another process holds locked does not stall a log call; the old table catches up in order, and the queue's overflow is counted", async () => {
		const dir = scratch();
		const store = openStore(`${dir}/chamberlain.db`);
		const obs = obsFor(store);
		const log = logFor(store);
		log("start", { dry: false });
		await Promise.resolve();
		const other = new Database(`${dir}/chamberlain.db`);
		other.exec("PRAGMA busy_timeout = 0");
		other.exec("BEGIN IMMEDIATE");
		const started = performance.now();
		for (let i = 0; i < 600; i++) log("fire", { kind: "failed", n: i });
		await Promise.resolve();
		expect(performance.now() - started).toBeLessThan(500);
		expect(eventRows(obs).filter((r) => r.event === "fire")).toHaveLength(600);
		expect(store.events.query().filter((e) => e.event === "fire")).toHaveLength(0);
		expect(obs.counters.dropped).toBe(100);
		other.exec("ROLLBACK");
		other.close();
		const old = store.events.query().filter((e) => e.event === "fire");
		expect(old.map((e) => e.n)).toEqual(Array.from({ length: 500 }, (_, i) => i + 100));
		store.close();
	});

	test("a reader inside a transaction that rolls back loses no queued line, outer or nested", async () => {
		const store = openStore(`${scratch()}/chamberlain.db`);
		const log = logFor(store);
		log("fire", { kind: "failed", n: 1 });
		expect(() =>
			store.tx(() => {
				store.events.count();
				throw Error("outer rolls back");
			}),
		).toThrow();
		log("fire", { kind: "failed", n: 2 });
		store.tx(() => {
			expect(() =>
				store.tx(() => {
					store.events.query();
					throw Error("inner rolls back");
				}),
			).toThrow();
		});
		log("fire", { kind: "failed", n: 3 });
		store.tx(() => {
			store.events.prune("1970-01-01T00:00:00.000Z");
		});
		await Promise.resolve();
		expect(store.events.query().map((e) => e.n)).toEqual([1, 2, 3]);
		store.close();
	});

	test("what still waits when the store closes is written then", () => {
		const dir = scratch();
		const store = openStore(`${dir}/chamberlain.db`);
		const log = logFor(store);
		const other = new Database(`${dir}/chamberlain.db`);
		other.exec("BEGIN IMMEDIATE");
		log("fire", { kind: "failed", n: 1 });
		other.exec("ROLLBACK");
		other.close();
		store.close();
		const check = openStore(`${dir}/chamberlain.db`);
		expect(check.events.query().map((e) => e.event)).toEqual(["fire"]);
		check.close();
	});

	// A misspelled event name is a compile error (tsc checks the tests too); this is never called.
	const _typo = () =>
		makeLogger(memObs(), {}).info(
			// @ts-expect-error not in the registry
			"wake.delivred",
			{},
		);
	void _typo;
});
