/** Active hold across the fleet: each server's card is held on that server's own signal and settled through that server's own read, and a server that cannot be read fails open. */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { noAlert } from "../../testing/alert.ts";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { createFakeAdapter } from "../../testing/fake-adapter.ts";
import { testRelayLock } from "../../testing/lock.ts";
import { memStore } from "../../testing/store.ts";
import { createEngine } from "./engine.ts";

const { thread, question } = useCoreEngineFixtures(createEngine);
const MIN = 60_000;
const ON = { enabled: true, windowMs: 5 * MIN };

describe("across servers", () => {
	/** A home server and a remote one, each with its own adapter: a card on the remote is read, held and settled through the remote's. */
	function fleet() {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-hold-fleet-`);
		const conf = `${root}/conf`;
		mkdirSync(conf, { recursive: true, mode: 0o700 });
		writeFileSync(`${conf}/decision-rights.md`, "rights", { mode: 0o600 });
		writeFileSync(`${conf}/steward-thread`, "steward-1", { mode: 0o600 });
		const store = memStore();
		const home = createFakeAdapter();
		const remote = createFakeAdapter();
		const events: { event: string; [k: string]: unknown }[] = [];
		const clock = { t: Date.now() };
		const engine = createEngine({
			conf,
			lock: testRelayLock(store),
			store,
			alert: noAlert,
			housekeeping: false,
			servers: [
				{ server: { name: "home", adapter: "fake" }, adapter: home },
				{ server: { name: "remote", adapter: "fake", environmentId: "env-2" }, adapter: remote },
			],
			log: (event, data) => events.push({ event, ...data }),
			timing: { debounceMs: 5, lagMs: 5, quietMs: 5, tickMs: 3_600_000 },
			relay: { retryAfterMs: () => 0, now: () => clock.t },
			activeHold: ON,
		});
		void engine.start();
		return { store, home, remote, events, clock, engine, root, stop: () => engine.stop() };
	}

	test("a card on a remote server is held on that server's signal and dropped on that server's read", async () => {
		const f = fleet();
		try {
			f.remote.threads.set("r1", { waiting: [{ ...question, requestId: "req-9" }], principalAt: f.clock.t - MIN });
			f.remote.emit({ kind: "needs_input", thread: thread("r1", "waiting", { pendingRequestId: "req-9" }) });
			const end = Date.now() + 3000;
			while (f.store.wakes.parked().length < 1 && Date.now() < end) await Bun.sleep(5);
			expect(f.store.wakes.parked()[0]!.parked).toMatchObject({ server: "remote", requestIds: ["req-9"] });
			// The home server's own view of the principal is not consulted for a remote thread: it was never asked.
			f.remote.threads.set("r1", { waiting: [], resolved: ["req-9"] });
			f.remote.emit({ kind: "state", thread: thread("r1", "running") });
			await f.engine.tick();
			const stop = Date.now() + 3000;
			while (!f.events.some((e) => e.event === "active-hold-dropped") && Date.now() < stop) await Bun.sleep(5);
			expect(f.events.find((e) => e.event === "active-hold-dropped")).toMatchObject({
				server: "remote",
				reason: "answered",
			});
			expect(f.home.wakes).toEqual([]);
		} finally {
			await f.stop();
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	test("a remote server that cannot be read wakes the Steward at once, logged as unavailable for that server", async () => {
		const f = fleet();
		try {
			f.remote.threads.set("r1", { waiting: [{ ...question, requestId: "req-9" }], principalAt: "error" });
			f.remote.emit({ kind: "needs_input", thread: thread("r1", "waiting", { pendingRequestId: "req-9" }) });
			const end = Date.now() + 3000;
			while (!f.home.wakes.some((w) => !w.deliveryId.includes(":rights-first:")) && Date.now() < end)
				await Bun.sleep(5);
			expect(f.home.wakes.some((w) => w.message.includes("Merge now?"))).toBe(true);
			expect(f.events.find((e) => e.event === "active-hold-unavailable")).toMatchObject({ server: "remote" });
		} finally {
			await f.stop();
			rmSync(f.root, { recursive: true, force: true });
		}
	});
});
