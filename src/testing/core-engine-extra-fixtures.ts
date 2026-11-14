import { expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ThreadInput } from "../core/adapter.ts";
import type { RunFailure } from "../core/adapter-inspect.ts";
import type { TurnItem } from "../core/decide.ts";
import { withDeliveryId } from "../core/deliver.ts";
import type { Engine } from "../core/engine.ts";
import type { EngineDeps } from "../core/engine-support.ts";
import type { Store } from "../core/store.ts";
import { noAlert } from "./alert.ts";
import { type Logged, useCoreEngineFixtures } from "./core-engine-fixtures.ts";
import { createFakeAdapter } from "./fake-adapter.ts";
import { testRelayLock } from "./lock.ts";
import { memStore } from "./store.ts";

/** The engine rig's idle-sweep, stalled-run and card-hold helpers, over the base rig. */
export function useCoreEngineExtraFixtures(makeEngine: (d: EngineDeps) => Engine) {
	const base = useCoreEngineFixtures(makeEngine);
	const { dirs, engines, rig, thread, question } = base;

	const idleRig = (conf?: object, classifierProvider?: EngineDeps["classifierProvider"]) => {
		const r = rig({ housekeeping: true, steward: "stew", ...(classifierProvider ? { classifierProvider } : {}) });
		if (conf) r.priv("sweep.json", JSON.stringify(conf));
		/** A last message that finished `min` minutes before the engine's clock. */
		const ago = (min: number, text: string, id = "m1") => ({
			id,
			text,
			at: new Date(r.clock.t - min * 60_000).toISOString(),
		});
		const seen = (id: string, status: string, over: Partial<ThreadInput>, last = ago(180, "All done.")) => {
			r.fake.threads.set(id, { lastAssistant: last });
			r.fake.emit({ kind: "state", thread: thread(id, status, over) });
		};
		const runs = () => r.events.filter((e) => e.event === "idle-parents").length;
		const sweeps = () => r.events.filter((e) => e.event === "sweep").length;
		/** Time passes for the engine's own clock; the message ages move with it. */
		const pass = (min: number) => {
			r.clock.t += min * 60_000;
		};
		return { r, ago, seen, runs, sweeps, pass };
	};

	const STREAM: RunFailure = {
		runId: "run-1",
		class: "unknown",
		message: "The provider event stream closed unexpectedly. Retry the turn.",
	};

	const FAST = {
		graceMs: 40,
		rateLimitWaitMs: 80,
		secondFailureWindowMs: 5_000,
		breakerWindowMs: 5_000,
		breakerQuietMs: 5_000,
	};

	const m1: TurnItem = {
		type: "user_message",
		id: "m1",
		text: "do the thing",
		createdBy: "user",
		creationSource: "user",
	};

	/** A rig whose engine has recovery on, with fast timing and a judge that answers from the test. */
	function make(
		judged: { verdict: string; reason: string } | "fail" = { verdict: "do_not_retry", reason: "it keeps failing" },
	) {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-recover-`);
		dirs.push(root);
		const conf = `${root}/conf`;
		mkdirSync(conf, { recursive: true, mode: 0o700 });
		writeFileSync(`${conf}/decision-rights.md`, "rights", { mode: 0o600 });
		const store = memStore();
		const fake = createFakeAdapter();
		const events: Logged[] = [];
		const asked: Record<string, any>[] = [];
		const judgeCalls: unknown[] = [];
		const clock = { t: Date.now() };
		const engine = makeEngine({
			conf,
			lock: testRelayLock(store),
			store,
			alert: noAlert,
			housekeeping: false,
			servers: [{ server: { name: "fake", adapter: "fake" }, adapter: fake }],
			log: (event, data) => events.push({ event, ...data }),
			timing: { debounceMs: 5, lagMs: 5, quietMs: 5, tickMs: 3_600_000 },
			relay: { retryAfterMs: () => 0, now: () => clock.t },
			recover: FAST,
			ask: async (raw) => {
				asked.push(raw as Record<string, any>);
			},
			judge: async (trigger, brief) => {
				judgeCalls.push({ trigger, brief });
				return judged === "fail"
					? { ok: false, backend: "small-model", error: "small-model judge exited 1" }
					: { ok: true, backend: "small-model", ...judged };
			},
		});
		engines.push(engine);
		void engine.start();
		const until = async (what: string, ok: () => boolean, ms = 3000) => {
			const end = Date.now() + ms;
			while (!ok()) {
				if (Date.now() > end)
					throw Error(`timed out waiting for ${what}; log: ${events.map((e) => e.event).join(", ")}`);
				await Bun.sleep(5);
			}
		};
		const failRun = (id: string, runId: string, failure: RunFailure, over: Partial<ThreadInput> = {}) => {
			fake.threads.set(id, {
				...(fake.threads.get(id) ?? {}),
				failure,
				instruction: { items: [m1], state: "complete", byMachine: false },
			});
			fake.emit({ kind: "state", thread: thread(id, "running", { latestRunId: runId, ...over }) });
			fake.emit({ kind: "state", thread: thread(id, "failed", { latestRunId: runId, ...over }) });
		};
		return { fake, events, asked, judgeCalls, until, failRun, store, quiet: (ms = 120) => Bun.sleep(ms) };
	}

	const waitingOn = (r: ReturnType<typeof rig>, id: string, req: string) => {
		r.fake.threads.set(id, { waiting: [{ ...question, requestId: req }] });
		r.fake.emit({ kind: "needs_input", thread: thread(id, "waiting", { pendingRequestId: req }) });
	};

	/** One full wake delivered, then a pointer queued while the webhook has nowhere to send: it sits pending. */
	async function pointerQueued() {
		const r = rig({ steward: "steward-1" });
		r.fake.probe = { readable: true, contextTokens: 1000 };
		waitingOn(r, "t1", "req-1");
		await r.until("the first wake", () => r.fake.wakes.length === 1);
		expect(r.fake.wakes[0]!.message).toContain("Decision rights (standing rules):");
		r.fake.setWakeReady(false);
		r.fake.probe = { readable: true, contextTokens: 2000 };
		waitingOn(r, "t2", "req-2");
		await r.until("the pointer row", () => r.store.wakes.rows().length === 1);
		const row = r.store.wakes.rows()[0]!;
		expect(row.message).toContain("Decision rights and rulings unchanged since");
		expect(row.message).not.toContain("Decision rights (standing rules):");
		return { r, row };
	}

	/** The wakes after the first full one: the rights-first wake, then the queued row byte for byte (with only its delivery-id line). */
	function rightsThenRow(r: ReturnType<typeof rig>, row: { deliveryId: string; message: string }) {
		const ids = r.fake.wakes.slice(1).map((w) => w.deliveryId);
		expect(ids).toHaveLength(2);
		expect(ids[0]!.startsWith(`${row.deliveryId}:rights-first:`)).toBe(true);
		expect(ids[1]).toBe(row.deliveryId);
		const first = r.fake.wakes[1]!;
		expect(first.message).toContain("Decision rights (standing rules):");
		expect(first.message).toContain("The Steward may merge green PRs.");
		expect(first.message).toContain(`(${row.deliveryId})`);
		expect(r.fake.wakes[2]!.message).toBe(withDeliveryId(row.message, row.deliveryId));
		expect(r.store.wakes.find(row.deliveryId)).toMatchObject({ status: "delivered", message: row.message });
		return first;
	}

	/**
	 * Finding 2, in process: the first engine stops at a point a crash could leave (its store refuses one attempt, as a kill before it would),
	 * then a second engine (the restart) over the same database. The record must be right from the database alone, and a later wake gets the
	 * pointer with nothing ahead of it.
	 */
	async function restartAfter(stopAt: "prerequisite queued" | "prerequisite delivered") {
		const { r, row } = await pointerQueued();
		r.priv("steward-thread", "steward-2");
		let blocked = false;
		const refuse = (id: number) => {
			const w = r.store.wakes.rows("all").find((x) => x.id === id);
			const hit =
				stopAt === "prerequisite queued" ? w?.deliveryId.includes(":rights-first:") : w?.deliveryId === row.deliveryId;
			if (hit) {
				blocked = true;
				throw Error("killed");
			}
		};
		const store: Store = {
			...r.store,
			wakes: {
				...r.store.wakes,
				beginAttempt: (id, now) => {
					refuse(id);
					return r.store.wakes.beginAttempt(id, now);
				},
			},
		};
		return {
			r,
			row,
			store,
			refuse: async () => {
				// The engine under test is restarted on the refusing store: it queues (and maybe delivers) the prerequisite, and stops there.
				await r.engine.stop();
				const first = rig({ store: r.store, wrap: () => store, steward: "steward-2" });
				first.fake.probe = { readable: true, contextTokens: 3000 };
				await first.until("the stop", () => blocked);
				await first.engine.stop();
				return first;
			},
		};
	}

	return {
		...base,
		STREAM,
		dirs,
		engines,
		idleRig,
		m1,
		make,
		pointerQueued,
		question,
		restartAfter,
		rig,
		rightsThenRow,
		thread,
		waitingOn,
	};
}
