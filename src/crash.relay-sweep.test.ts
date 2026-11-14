/** crash, continued: the relay, two-daemon and sweep paths. See crash.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import {
	accepted,
	daemon,
	daemonArgs,
	diedAt,
	outbox,
	registerCrashHooks,
	rows,
	secret,
	TIMEOUT,
	type World,
	wakes,
	world,
} from "./testing/crash-fixtures.ts";

registerCrashHooks();

// ---- the relay path -------------------------------------------------------------------------------

describe("relay path: the real daemon dies at each step of sending a row, and its restart keeps the bound", () => {
	const ID = "Q-dmon1",
		DELIVERY = "answer:item:Q-dmon1";
	/** A producer wrote this row; the daemon dies at `step` sending it. */
	async function left(step: string) {
		const w = await world(ID);
		w.store.wakes.enqueue({ deliveryId: DELIVERY, message: `[chamberlain] answer: item ${ID}`, queuedAt: Date.now() });
		await diedAt(w.spawn(daemonArgs, step), step);
		return w;
	}

	test(
		"inside the attempt's transaction: the count did not commit and nothing was sent; the restart sends it once",
		async () => {
			const w = await left("attempt-begun");
			expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "pending", attempts: 0 }]);
			expect(accepted).toHaveLength(0);
			await daemon(w, () => accepted.length > 0);
			wakes(ID, DELIVERY);
			expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "delivered", attempts: 1 }]);
		},
		TIMEOUT,
	);

	test(
		"after the attempt committed, before the POST: the attempt is spent; the restart sends it once, as attempt two",
		async () => {
			const w = await left("attempt-counted");
			expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "pending", attempts: 1 }]);
			expect(accepted).toHaveLength(0);
			await daemon(w, () => accepted.length > 0);
			wakes(ID, DELIVERY);
			expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "delivered", attempts: 2 }]);
		},
		TIMEOUT,
	);

	test(
		"after the POST was accepted, before the delivered commit: the documented window, two POSTs under one id and one text",
		async () => {
			const w = await left("accepted");
			wakes(ID, DELIVERY, 1);
			expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "pending", attempts: 1 }]);
			await daemon(w, () => accepted.length > 1);
			wakes(ID, DELIVERY, 2);
			expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "delivered", attempts: 2 }]);
			await daemon(w);
			wakes(ID, DELIVERY, 2);
		},
		TIMEOUT,
	);

	test(
		"killed in that window on every start: exactly three POSTs, then a dead letter that no restart sends",
		async () => {
			const w = await left("accepted");
			for (const n of [2, 3])
				await diedAt(w.spawn(daemonArgs, "accepted"), "accepted").then(() => expect(accepted).toHaveLength(n));
			expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "pending", attempts: 3 }]);
			await daemon(w, () => outbox(w)[0]!.status === "dead_letter");
			wakes(ID, DELIVERY, 3);
			expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "dead_letter", attempts: 3 }]);
		},
		TIMEOUT,
	);

	test(
		"killed after the count, before the POST, on every start: three attempts, ZERO POSTs, a dead letter nothing delivered",
		async () => {
			const w = await left("attempt-counted");
			for (const n of [2, 3]) {
				await diedAt(w.spawn(daemonArgs, "attempt-counted"), "attempt-counted");
				expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "pending", attempts: n }]);
			}
			await daemon(w, () => outbox(w)[0]!.status === "dead_letter");
			expect(accepted).toHaveLength(0);
			expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "dead_letter", attempts: 3 }]);
			expect(
				rows(w, "SELECT dedup_key FROM items WHERE source = 'alarm'")
					.map((r) => String(r.dedup_key))
					.join(" "),
			).toContain("wake-dead-letter");
		},
		TIMEOUT,
	);

	test(
		"after the delivered commit: the restart sends nothing more and the answer is marked delivered",
		async () => {
			const w = await left("delivered");
			wakes(ID, DELIVERY, 1);
			expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "delivered", attempts: 1 }]);
			await daemon(w);
			wakes(ID, DELIVERY, 1);
		},
		TIMEOUT,
	);

	test(
		"after a digest is composed, before it is sent: the restart sends that row, its id and members as composed",
		async () => {
			const w = await world(ID);
			for (const id of ["sweep:1", "sweep:2"])
				w.store.wakes.hold({
					deliveryId: id,
					message: `[chamberlain] sweep: finding ${id}`,
					queuedAt: Date.now(),
					kind: "sweep",
				});
			await diedAt(w.spawn(daemonArgs, "composed"), "composed");
			expect(rows(w, "SELECT 1 FROM held_wakes")).toEqual([]);
			const [digest] = outbox(w);
			expect(digest).toMatchObject({ status: "pending", attempts: 0 });
			expect(rows(w, "SELECT delivery_id FROM outbox_members ORDER BY delivery_id")).toEqual([
				{ delivery_id: "sweep:1" },
				{ delivery_id: "sweep:2" },
			]);
			expect(accepted).toHaveLength(0);
			await daemon(w, () => accepted.length > 0);
			expect(accepted.map((a) => a.deliveryId)).toEqual([String(digest!.delivery_id)]);
			for (const id of ["sweep:1", "sweep:2"]) expect(accepted[0]!.message).toContain(`deliveryId: ${id}`);
			expect(outbox(w)).toEqual([{ ...digest, status: "delivered", attempts: 1 }]);
		},
		TIMEOUT,
	);
});

// ---- one relay per state directory -----------------------------------------------------------------

describe("two real daemons on one state directory: exactly one relays", () => {
	test(
		"the second exits 5 and says why; every wake goes once, from the first; when the first is gone the next one starts",
		async () => {
			const w = await world("Q-two01");
			const first = w.spawn(daemonArgs);
			await w.until("the first daemon's relay", () => w.events().some((e) => e.event === "startup-recovered"));
			// Another environment (a different runtime and temporary directory) does not make it another relay: the lock is the state directory's.
			const second = w.spawn(daemonArgs, undefined, {
				XDG_RUNTIME_DIR: `${w.conf}/other-runtime`,
				TMPDIR: `${w.conf}/other-tmp`,
			});
			expect(await second.exited).toBe(5);
			expect(await new Response(second.stderr).text()).toContain(
				"another chamberlain daemon is already running on this database",
			);
			w.store.wakes.enqueue({
				deliveryId: "answer:item:Q-two01",
				message: "[chamberlain] answer: item Q-two01",
				queuedAt: Date.now(),
			});
			await w.until("the wake", () => accepted.length > 0);
			await Bun.sleep(2500);
			wakes("Q-two01", "answer:item:Q-two01");
			first.kill(9);
			await first.exited;
			await daemon(w);
			wakes("Q-two01", "answer:item:Q-two01");
		},
		TIMEOUT,
	);
});

// ---- the sweep path ------------------------------------------------------------------------------

describe("sweep path: the real daemon dies between a finding's notification and its wake, and the alert is not lost", () => {
	const FINDING = "the root disk is 97% full";
	/** A daemon whose once-a-minute heartbeat runs every 100 ms, so the first sweep happens at once. */
	const fast = { CHAMBERLAIN_TICK_MS: "100" };
	async function world_() {
		const w = await world("Q-swp01");
		secret(
			`${w.conf}/sweep.json`,
			JSON.stringify({
				checks: [{ name: "disk", command: ["/bin/echo", JSON.stringify([{ dedupKey: "root", text: FINDING }])] }],
			}),
		);
		return w;
	}
	const items = (w: World) => rows(w, "SELECT state, notification_count FROM items WHERE source = 'check:disk'");
	const clock = (w: World) =>
		rows(w, "SELECT value FROM state WHERE key = 'sweep-clock'").map(
			(r) => JSON.parse(String(r.value)) as { seeded: boolean },
		);
	/** A fresh daemon, run until `until` holds (or it dies), then stopped. */
	async function run(w: World, until: () => boolean, crashAt?: string) {
		const p = w.spawn(daemonArgs, crashAt, fast);
		if (crashAt) {
			await diedAt(p, crashAt);
			return;
		}
		await w.until("the wake", until);
		await Bun.sleep(400);
		p.kill();
		await p.exited;
	}

	test(
		"killed inside the transaction that records the finding and queues its wake: neither exists, and the restart wakes the Steward once",
		async () => {
			const w = await world_();
			await run(w, () => true, "notified");
			expect(items(w)).toEqual([]);
			expect(rows(w, "SELECT 1 FROM outbox")).toEqual([]);
			expect(rows(w, "SELECT 1 FROM held_wakes")).toEqual([]);
			expect(clock(w).every((c) => !c.seeded)).toBe(true);
			expect(accepted).toHaveLength(0);
			await run(w, () => accepted.length >= 1);
			expect(accepted).toHaveLength(1);
			expect(accepted[0]!.message).toContain(FINDING);
			expect(items(w)).toEqual([{ state: "triggered", notification_count: 1 }]);
			await run(w, () => true);
			expect(accepted).toHaveLength(1);
		},
		TIMEOUT,
	);

	test(
		"killed right after that transaction: the finding and its wake are both there, and the restart sends the one wake",
		async () => {
			const w = await world_();
			await run(w, () => true, "enqueued");
			expect(items(w)).toEqual([{ state: "triggered", notification_count: 1 }]);
			expect(rows(w, "SELECT delivery_id FROM held_wakes")).toHaveLength(1);
			expect(accepted).toHaveLength(0);
			await run(w, () => accepted.length >= 1);
			expect(accepted).toHaveLength(1);
			expect(accepted[0]!.message).toContain(FINDING);
		},
		TIMEOUT,
	);
});
