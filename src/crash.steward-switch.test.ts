/**
 * M4 / C2–C4: real SIGKILL at Steward switch crash points, then reopen.
 * No POST before steward-recovered on daemon restart (C4).
 */
import { describe, expect, test } from "bun:test";
import { publishSwitchRef, seedGen1 } from "./core/steward-gens.ts";
import { prepareSwitch } from "./core/steward-prepare.ts";
import { accepted, daemon, diedAt, registerCrashHooks, rows, SRC, TIMEOUT, world } from "./testing/crash-fixtures.ts";

registerCrashHooks();

const cli = [`${SRC}cli.ts`];

async function preparedSwitch(w: Awaited<ReturnType<typeof world>>) {
	seedGen1(w.store, w.conf);
	const prep = prepareSwitch(w.store, w.conf, { toThread: "thread-g2", live: true });
	if (!prep.ok) throw new Error(prep.error);
	const wake = `http://127.0.0.1:${w.port}/wake\n`;
	publishSwitchRef(w.conf, prep.id, "wake", wake);
	publishSwitchRef(w.conf, prep.id, "compact", `http://127.0.0.1:${w.port}/compact\n`);
	return prep.id;
}

describe("Steward switch SIGKILL / reopen (C2/C3/C4)", () => {
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
});
