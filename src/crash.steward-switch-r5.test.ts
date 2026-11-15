/**
 * Sol R5 crash evidence: C3 distinct u1/u2, C4 recovery-before-POST, commit-partial rollback.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { publishSwitchRef, seedGen1 } from "./core/steward-gens.ts";
import { prepareSwitch } from "./core/steward-prepare.ts";
import {
	accepted,
	daemon,
	daemonArgs,
	diedAt,
	outbox,
	registerCrashHooks,
	rows,
	SRC,
	setWakeReceiptProbe,
	TIMEOUT,
	world,
} from "./testing/crash-fixtures.ts";

registerCrashHooks();

const cli = [`${SRC}cli.ts`];

function wakeUrlOf(w: Awaited<ReturnType<typeof world>>): string {
	for (const p of [`${w.conf}/secrets/wake-url`, `${w.conf}/wake-url`]) {
		try {
			return readFileSync(p, "utf8").trim();
		} catch {
			/* next */
		}
	}
	throw new Error("wake-url missing");
}

async function preparedSwitch(w: Awaited<ReturnType<typeof world>>, wakeOverride?: string) {
	seedGen1(w.store, w.conf);
	const prep = prepareSwitch(w.store, w.conf, { toThread: "thread-g2", live: true });
	if (!prep.ok) throw new Error(prep.error);
	const wake = `${wakeOverride ?? wakeUrlOf(w)}\n`;
	publishSwitchRef(w.conf, prep.id, "wake", wake);
	publishSwitchRef(w.conf, prep.id, "compact", wake.replace("/wake", "/compact"));
	return prep.id;
}

describe("Steward switch R5 crash evidence (C3/C4/partial)", () => {
	test(
		"C3: accepted at u1, commit while down, restart — R POSTs to distinct u2; ledger gen 2",
		async () => {
			const w = await world("Q-sw3b");
			seedGen1(w.store, w.conf);
			w.store.wakes.enqueue({ deliveryId: "R-c3", message: "in flight at g1", queuedAt: Date.now() });
			await diedAt(w.spawn(daemonArgs, "accepted"), "accepted");
			expect(accepted.some((a) => a.deliveryId === "R-c3")).toBe(true);
			const u1Count = accepted.filter((a) => a.deliveryId === "R-c3").length;

			const u2Posts: { deliveryId: string }[] = [];
			const u2 = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch: async (r) => {
					u2Posts.push((await r.json()) as { deliveryId: string });
					return new Response(null, { status: 202 });
				},
			});
			try {
				const id = await preparedSwitch(w, `http://127.0.0.1:${u2.port}/wake`);
				const commit = w.spawn([...cli, "steward", "switch", id, "--live"]);
				await commit.exited;
				expect(commit.exitCode).toBe(0);
				await daemon(w, () => u2Posts.some((p) => p.deliveryId === "R-c3") || outbox(w)[0]?.status === "delivered");
				expect(u2Posts.some((p) => p.deliveryId === "R-c3")).toBe(true);
				expect(accepted.filter((a) => a.deliveryId === "R-c3")).toHaveLength(u1Count);
				expect(rows(w, "SELECT item_id FROM transfer_items")).toEqual([]);
				const led = rows(
					w,
					"SELECT gen FROM steward_deliveries WHERE outbox_id = (SELECT id FROM outbox WHERE delivery_id = 'R-c3')",
				);
				expect(led).toHaveLength(1);
				expect(led[0]!.gen).toBe(2);
			} finally {
				u2.stop(true);
			}
		},
		TIMEOUT,
	);

	test(
		"C4: at webhook receipt, steward-recovered already happened",
		async () => {
			const w = await world("Q-sw4b");
			seedGen1(w.store, w.conf);
			w.store.wakes.enqueue({ deliveryId: "pre-switch", message: "old work", queuedAt: Date.now() });
			const row = w.store.wakes.find("pre-switch")!;
			w.store.wakes.finish(row.id, "delivered", Date.now());
			w.store.steward.insertLedger({ outboxId: row.id, gen: 1, origin: "live" });
			const id = await preparedSwitch(w);
			const commit = w.spawn([...cli, "steward", "switch", id, "--live"]);
			await commit.exited;
			expect(commit.exitCode).toBe(0);
			expect(accepted).toHaveLength(0);

			const atReceipt: boolean[] = [];
			setWakeReceiptProbe(() => {
				const ev = w.store.events.query({ events: ["steward-recovered"] }) as { event: string }[];
				atReceipt.push(ev.some((e) => e.event === "steward-recovered"));
			});
			await daemon(w, () => rows(w, "SELECT item_id FROM transfer_items").length > 0 || atReceipt.length > 0);
			expect(atReceipt.length).toBeGreaterThan(0);
			expect(atReceipt.every(Boolean)).toBe(true);
		},
		TIMEOUT,
	);

	test(
		"kill at switch-commit-partial rolls back — no gen 2, no transfer",
		async () => {
			const w = await world("Q-sw-partial");
			const id = await preparedSwitch(w);
			const p = w.spawn([...cli, "steward", "switch", id, "--live"], "switch-commit-partial");
			await diedAt(p, "switch-commit-partial");
			expect(rows(w, "SELECT gen FROM steward_gens").map((r) => r.gen)).toEqual([1]);
			expect(rows(w, "SELECT from_gen FROM steward_transfers")).toEqual([]);
			expect(rows(w, "SELECT phase FROM steward_switches").map((r) => r.phase)).toEqual(["preparing"]);
		},
		TIMEOUT,
	);
});
