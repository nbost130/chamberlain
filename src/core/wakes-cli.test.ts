/** The operator's wakes commands, pinned through `runWakesCli`: what each prints and which exit code it returns. */
import { describe, expect, test } from "bun:test";
import { memStore } from "../testing/store.ts";
import type { Store } from "./store.ts";
import { runWakesCli, wakesUsage } from "./wakes-cli.ts";

const ENV = { CHAMBERLAIN_MAX_ATTEMPTS: "3" };
const T0 = Date.UTC(2026, 0, 2, 3, 4, 5);

/** A store with one row in every status the list reports, plus one held wake. */
function world(): Store {
	const store = memStore();
	const { wakes } = store;
	wakes.enqueue({ deliveryId: "dead1", message: "m", queuedAt: T0, receiver: "desk" });
	for (let i = 0; i < 3; i++) {
		const row = wakes.find("dead1");
		if (row) wakes.beginAttempt(row.id, T0 + 1000 * (i + 1));
	}
	const dead = wakes.find("dead1");
	if (dead) wakes.finish(dead.id, "dead_letter", T0 + 4000);
	wakes.enqueue({ deliveryId: "pend1", message: "m", queuedAt: T0 });
	wakes.enqueue({ deliveryId: "gone1", message: "m", queuedAt: T0 });
	wakes.cancel("gone1", T0 + 5000);
	wakes.hold({ deliveryId: "held1", message: "m", queuedAt: T0 });
	return store;
}
const run = (store: Store, argv: string[]) => {
	const out: string[] = [];
	const code = runWakesCli(store, argv, (l) => out.push(l), ENV);
	return { code, out };
};

describe("list", () => {
	test("prints the dead letters, the pending rows, the held count and the cancelled count, and exits 0", () => {
		const { code, out } = run(world(), ["list"]);
		expect(code).toBe(0);
		expect(out).toEqual([
			"dead letters (attempted 3 times without being delivered, not sent again until you retry or cancel): 1",
			"  dead1  for desk  3/3 attempts  created 2026-01-02T03:04:05.000Z  last tried 2026-01-02T03:04:08.000Z",
			"pending (the daemon's relay is sending them): 1",
			"  pend1  0/3 attempts  created 2026-01-02T03:04:05.000Z  last tried -",
			"held for the Steward to go idle: 1",
			"cancelled (kept as tombstones, so nothing queues them again): 1",
		]);
	});

	test("an empty outbox lists zeros and omits the cancelled line", () => {
		const { code, out } = run(memStore(), ["list"]);
		expect(code).toBe(0);
		expect(out.map((l) => l.replace(/^.*: (\d+)$/, "$1"))).toEqual(["0", "0", "0"]);
	});

	test("list with an extra argument is a usage error", () => {
		const { code, out } = run(world(), ["list", "extra"]);
		expect(code).toBe(2);
		expect(out).toEqual([wakesUsage()]);
	});
});

describe("retry and cancel", () => {
	test("retry puts a dead letter back to pending and says so", () => {
		const store = world();
		const { code, out } = run(store, ["retry", "dead1"]);
		expect(code).toBe(0);
		expect(out).toHaveLength(1);
		expect(out[0]).toStartWith("retry: dead1 is pending again with its attempts at zero (up to 3 more);");
		expect(store.wakes.find("dead1")).toMatchObject({ status: "pending", attempts: 0 });
	});

	test("retry of a row that is not a dead letter is refused with exit 1", () => {
		const { code, out } = run(world(), ["retry", "pend1"]);
		expect(code).toBe(1);
		expect(out).toEqual(["retry: pend1 is pending, not a dead letter; only a dead letter can be retried"]);
	});

	test("cancel gives up a pending row and a dead letter, and keeps a tombstone", () => {
		const store = world();
		for (const id of ["pend1", "dead1"]) {
			const { code, out } = run(store, ["cancel", id]);
			expect(code).toBe(0);
			expect(out).toEqual([
				`cancel: ${id} is cancelled and kept as a tombstone; it is not recorded as delivered and nothing will send or queue it again`,
			]);
			expect(store.wakes.find(id)?.status).toBe("cancelled");
		}
	});

	test("cancel of an already cancelled row is refused with exit 1", () => {
		const { code, out } = run(world(), ["cancel", "gone1"]);
		expect(code).toBe(1);
		expect(out).toEqual(["cancel: gone1 is already cancelled"]);
	});

	test("an unknown id is reported for both commands with exit 1", () => {
		for (const cmd of ["retry", "cancel"]) {
			const { code, out } = run(world(), [cmd, "nope"]);
			expect(code).toBe(1);
			expect(out).toEqual([`${cmd}: no outbox row has the id nope ("list" shows what is waiting)`]);
		}
	});
});

describe("usage", () => {
	test("no command, an unknown command, a missing id or a spare argument prints the usage and exits 2", () => {
		for (const argv of [[], ["bogus"], ["retry"], ["cancel"], ["retry", "a", "b"]]) {
			const { code, out } = run(world(), argv);
			expect(code).toBe(2);
			expect(out).toEqual([wakesUsage()]);
		}
	});
});
