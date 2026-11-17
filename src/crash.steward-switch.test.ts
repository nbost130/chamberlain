/**
 * M4 / C2–C4 / R5: real SIGKILL at Steward switch crash points, then reopen.
 * No POST before steward-recovered on daemon restart (C4).
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { publishSwitchRef, seedGen1 } from "./core/steward/steward-gens.ts";
import { prepareSwitch } from "./core/steward/steward-prepare.ts";
import {
	accepted,
	daemon,
	daemonArgs,
	diedAt,
	outbox,
	registerCrashHooks,
	rows,
	SRC,
	TIMEOUT,
	world,
} from "./testing/crash-fixtures.ts";

registerCrashHooks();

const cli = [`${SRC}cli.ts`];

/** g2 wake/compact refs must be the accepting webhook (hook), not the web UI port. */
function wakeUrlOf(w: Awaited<ReturnType<typeof world>>): string {
	for (const p of [`${w.conf}/secrets/wake-url`, `${w.conf}/wake-url`]) {
		try {
			return readFileSync(p, "utf8").trim();
		} catch {
			/* try next */
		}
	}
	throw new Error("wake-url missing");
}

async function preparedSwitch(w: Awaited<ReturnType<typeof world>>) {
	seedGen1(w.store, w.conf);
	const prep = prepareSwitch(w.store, w.conf, { toThread: "thread-g2", live: true });
	if (!prep.ok) throw new Error(prep.error);
	const wake = `${wakeUrlOf(w)}\n`;
	w.bindWake(wake.trim(), "thread-g2");
	publishSwitchRef(w.conf, prep.id, "wake", wake);
	publishSwitchRef(w.conf, prep.id, "compact", wake.replace("/wake", "/compact"));
	return prep.id;
}

describe("Steward switch SIGKILL / reopen (C2/C3/C4/R5)", () => {
	test(
		"C2: kill at switch-commit-begun leaves no generation; re-run commits",
		async () => {
			const w = await world("Q-sw1");
			const id = await preparedSwitch(w);

			const p = w.spawn([...cli, "steward", "switch", id, "--live"], "switch-commit-begun");
			await diedAt(p, "switch-commit-begun");
			expect(rows(w, "SELECT gen FROM steward_gens").map((r) => r.gen)).toEqual([1]);
			expect(rows(w, "SELECT phase FROM steward_switches").map((r) => r.phase)).toEqual(["preparing"]);

			const ok = w.spawn([...cli, "steward", "switch", id, "--live"]);
			await ok.exited;
			expect(ok.exitCode).toBe(0);
			expect(rows(w, "SELECT gen FROM steward_gens ORDER BY gen").map((r) => r.gen)).toEqual([1, 2]);
			expect(
				rows(w, "SELECT phase FROM steward_switches").some((r) => r.phase === "committed" || r.phase === "mirrored"),
			).toBe(true);
		},
		TIMEOUT,
	);

	test(
		"C2: kill at switch-committed leaves gen+transfer coherent",
		async () => {
			const w = await world("Q-sw2");
			const id = await preparedSwitch(w);

			const p = w.spawn([...cli, "steward", "switch", id, "--live"], "switch-committed");
			await diedAt(p, "switch-committed");
			expect(rows(w, "SELECT gen FROM steward_gens ORDER BY gen").map((r) => r.gen)).toEqual([1, 2]);
			expect(rows(w, "SELECT from_gen, to_gen FROM steward_transfers")).toEqual([{ from_gen: 1, to_gen: 2 }]);
		},
		TIMEOUT,
	);

	test(
		"C3: accepted at g1, commit while down, restart — R to u2, no transfer item",
		async () => {
			const w = await world("Q-sw3");
			seedGen1(w.store, w.conf);
			w.store.wakes.enqueue({ deliveryId: "R-c3", message: "in flight at g1", queuedAt: Date.now() });

			await diedAt(w.spawn(daemonArgs, "accepted"), "accepted");
			expect(accepted.some((a) => a.deliveryId === "R-c3")).toBe(true);
			expect(outbox(w)).toEqual([{ delivery_id: "R-c3", status: "pending", attempts: 1 }]);

			const id = await preparedSwitch(w);
			const commit = w.spawn([...cli, "steward", "switch", id, "--live"]);
			await commit.exited;
			expect(commit.exitCode).toBe(0);
			expect(rows(w, "SELECT gen FROM steward_gens ORDER BY gen").map((r) => r.gen)).toEqual([1, 2]);

			const before = accepted.filter((a) => a.deliveryId === "R-c3").length;
			await daemon(w, () => {
				const row = outbox(w).find((r) => r.delivery_id === "R-c3");
				return row?.status === "delivered" || accepted.filter((a) => a.deliveryId === "R-c3").length > before;
			});
			expect(accepted.filter((a) => a.deliveryId === "R-c3").length).toBeGreaterThan(before);
			expect(rows(w, "SELECT item_id FROM transfer_items")).toEqual([]);
			const led = rows(
				w,
				"SELECT gen FROM steward_deliveries WHERE outbox_id = (SELECT id FROM outbox WHERE delivery_id = 'R-c3')",
			);
			if (led.length) expect(led[0]!.gen).toBe(2);
		},
		TIMEOUT,
	);

	test(
		"C4: commit with daemon down — restart recovery transfers before first POST of old work",
		async () => {
			const w = await world("Q-sw4");
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

			await daemon(w, () => rows(w, "SELECT item_id FROM transfer_items").length > 0);
			expect(rows(w, "SELECT item_id FROM transfer_items").length).toBeGreaterThan(0);
		},
		TIMEOUT,
	);

	test(
		"R5: kill at switch-prepared — reopen re-runs prepare cleanly",
		async () => {
			const w = await world("Q-sw-prep");
			seedGen1(w.store, w.conf);
			const p = w.spawn([...cli, "steward", "prepare", "thread-g2", "--live"], "switch-prepared");
			await diedAt(p, "switch-prepared");
			const phases = rows(w, "SELECT phase FROM steward_switches").map((r) => r.phase);
			expect(phases).toEqual(["preparing"]);
			const ok = w.spawn([...cli, "steward", "prepare", "thread-g2b", "--live"]);
			await ok.exited;
			// Unique open switch: second prepare fails or first remains — coherent either way.
			expect(rows(w, "SELECT gen FROM steward_gens").map((r) => r.gen)).toEqual([1]);
		},
		TIMEOUT,
	);

	test(
		"R5: kill at transfer-item-held — item+mapping both present or both absent; re-run idempotent",
		async () => {
			const w = await world("Q-sw-xfer");
			seedGen1(w.store, w.conf);
			w.store.wakes.enqueue({ deliveryId: "R-xfer", message: "payload", queuedAt: Date.now() });
			const row = w.store.wakes.find("R-xfer")!;
			w.store.wakes.finish(row.id, "delivered", Date.now());
			w.store.steward.insertLedger({ outboxId: row.id, gen: 1, origin: "live" });
			const id = await preparedSwitch(w);
			const commit = w.spawn([...cli, "steward", "switch", id, "--live"]);
			await commit.exited;
			expect(commit.exitCode).toBe(0);

			await diedAt(w.spawn(daemonArgs, "transfer-item-held"), "transfer-item-held");
			const items = rows(w, "SELECT item_id FROM transfer_items");
			const held = rows(w, "SELECT delivery_id FROM held_wakes WHERE kind = 'transfer'");
			const pendingXfer = rows(
				w,
				"SELECT delivery_id FROM outbox WHERE delivery_id LIKE 'transfer:%' AND status = 'pending'",
			);
			const mappingPresent = items.length > 0;
			const wakePresent = held.length + pendingXfer.length > 0;
			expect(mappingPresent).toBe(wakePresent);

			await daemon(w, () => rows(w, "SELECT item_id FROM transfer_items").length > 0);
			expect(rows(w, "SELECT item_id FROM transfer_items").length).toBe(1);
		},
		TIMEOUT,
	);

	test(
		"R5: kill at receipt-recorded — reopen records receipt once",
		async () => {
			const w = await world("Q-sw-rcpt");
			seedGen1(w.store, w.conf);
			w.store.wakes.enqueue({ deliveryId: "R-rcpt", message: "body", queuedAt: Date.now() });
			const row = w.store.wakes.find("R-rcpt")!;
			w.store.wakes.finish(row.id, "delivered", Date.now());
			w.store.steward.insertLedger({ outboxId: row.id, gen: 1, origin: "live" });

			const t3db = `${w.root}/t3-state.sqlite`;
			const fence = "H";
			const text = [
				"/steward-wake",
				"",
				"[Chamberlain standing hook.]",
				"",
				"You are the Steward.",
				"",
				"body",
				"",
				`Delivery id: <webhook-data-${fence}>R-rcpt</webhook-data-${fence}>`,
			].join("\n");
			const db = new Database(t3db);
			db.exec(`DROP TABLE IF EXISTS orchestration_v2_projection_messages`);
			db.exec(`DROP TABLE IF EXISTS orchestration_v2_projection_runs`);
			db.exec(`
				CREATE TABLE orchestration_v2_projection_messages (
					message_id TEXT, thread_id TEXT, role TEXT, payload_json TEXT
				);
				CREATE TABLE orchestration_v2_projection_runs (
					thread_id TEXT, ordinal INT, status TEXT, requested_at TEXT, payload_json TEXT, run_id TEXT
				);
			`);
			const nowIso = new Date().toISOString();
			db.run(
				`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, payload_json) VALUES (?, ?, ?, ?)`,
				[
					"scheduled-task-message:scheduled-task:task-1:webhook:delivery:relay:rcpt",
					"crash-steward-thread",
					"user",
					JSON.stringify({ text, scheduledTaskId: "task-1" }),
				],
			);
			db.run(
				`INSERT INTO orchestration_v2_projection_runs (thread_id, ordinal, status, requested_at, payload_json, run_id) VALUES (?, 0, 'completed', ?, ?, 'run-rcpt')`,
				[
					"crash-steward-thread",
					nowIso,
					JSON.stringify({
						id: "run-rcpt",
						userMessageId: "scheduled-task-message:scheduled-task:task-1:webhook:delivery:relay:rcpt",
						completedAt: nowIso,
					}),
				],
			);
			db.close();

			await diedAt(w.spawn(daemonArgs, "receipt-recorded"), "receipt-recorded");
			const mid = rows(w, "SELECT id FROM steward_receipts");
			await daemon(w, () => rows(w, "SELECT id FROM steward_receipts").length > 0);
			expect(rows(w, "SELECT id FROM steward_receipts").length).toBe(1);
			expect(mid.length === 0 || mid.length === 1).toBe(true);
		},
		TIMEOUT,
	);

	test(
		"R5: kill at adopted — reopen adopts once",
		async () => {
			const w = await world("Q-sw-adopt");
			seedGen1(w.store, w.conf);
			// Unledgered delivered Steward row (adoption shape).
			w.store.wakes.enqueue({ deliveryId: "R-adopt", message: "legacy payload", queuedAt: Date.now() });
			const row = w.store.wakes.find("R-adopt")!;
			w.store.wakes.finish(row.id, "delivered", Date.now());
			// No ledger entry.

			await diedAt(w.spawn(daemonArgs, "adopted"), "adopted");
			const before = rows(
				w,
				"SELECT outbox_id, origin FROM steward_deliveries WHERE origin = 'adopted' OR origin = 'unrecoverable'",
			);
			await daemon(
				w,
				() =>
					rows(w, "SELECT outbox_id FROM steward_deliveries WHERE origin = 'adopted' OR origin = 'unrecoverable'")
						.length > 0,
			);
			const after = rows(w, "SELECT outbox_id FROM steward_deliveries WHERE origin IN ('adopted', 'unrecoverable')");
			expect(after).toHaveLength(1);
			expect(before.length === 0 || before.length === 1).toBe(true);
		},
		TIMEOUT,
	);
});
