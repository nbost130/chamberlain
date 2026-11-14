/**
 * Chamberlain's engine: a zero-model-call watcher. It takes the thread events an adapter reports (adapter.ts), applies the
 * plain rules in decide.ts, and wakes the Steward through the adapter's `wake` when a thread needs the operator (a
 * pending question or approval, a failed top-level run, or a top-level turn that ends by handing back a question). It
 * never speaks a backend's protocol: every backend fact arrives through the Adapter, and every optional capability an
 * adapter lacks switches one feature off (see the table in adapter.ts). src/daemon.ts builds the real deps for it.
 */
import type { Adapter } from "./adapter.ts";
import { has } from "./adapter-conformance.ts";
import { DESK_RECEIVER } from "./alert-desk-config.ts";
import { lastInstruction } from "./decide.ts";
import { createOutbox } from "./deliver.ts";
import { CoreWork } from "./engine-core-work.ts";
import type { createIdleParents } from "./engine-idle.ts";
import {
	adapterOf,
	defaultTiming,
	deskLaneOf,
	type EngineDeps,
	type EngineTiming,
	RECOVER_KEY,
} from "./engine-support.ts";
import { createSweep } from "./engine-sweep.ts";
import { Watcher } from "./engine-watcher.ts";
import { createJudge, type Judge, judgeOff, readJudgeConfig } from "./judge.ts";
import { type Log, makeLog } from "./log.ts";
import { NOTIFICATION_LOG } from "./notification.ts";
import { recordAnswerDelivered } from "./questions-wake.ts";
import { createRecovery, type Recovery } from "./recover.ts";
import { DEFAULT_RECOVER_TIMING, type RecoverTiming } from "./recover-classify.ts";
import type { RecoverState } from "./recover-state.ts";
import { createRelay, type Relay } from "./relay.ts";
import { openRightsSent } from "./rights-sent.ts";
import { homeServer, type ServerEntry } from "./servers.ts";
import type { Store } from "./store.ts";

export class Core extends CoreWork {
	readonly conf: string;
	readonly store: Store;
	readonly DRY: boolean;
	readonly t: EngineTiming;
	readonly EXCLUDE: Set<string>;
	readonly log: Log;
	readonly home: ServerEntry;
	readonly homeAdapter: Adapter;
	readonly deskLane: ReturnType<typeof deskLaneOf>;
	readonly relay: Relay;
	readonly outbox: ReturnType<typeof createOutbox>;
	readonly deliver: ReturnType<typeof createOutbox>["deliver"];
	readonly watchers: Watcher[];
	readonly timing: RecoverTiming;
	protected readonly judge: Judge;
	protected readonly rightsSent: ReturnType<typeof openRightsSent>;
	protected readonly stewardCheck: () => Promise<void>;
	protected readonly sweep: ReturnType<typeof createSweep>;
	protected readonly idleParents: ReturnType<typeof createIdleParents>;
	protected readonly heartbeat: () => void;
	protected readonly healthTick: (() => Promise<unknown>) | undefined;
	protected readonly usageTick: (() => Promise<unknown>) | undefined;

	constructor(protected readonly d: EngineDeps) {
		super();
		this.conf = d.conf;
		this.store = d.store;
		this.DRY = d.dry === true;
		this.t = { ...defaultTiming(), ...d.timing };
		this.EXCLUDE = new Set(d.exclude ?? []);
		this.log = d.log ?? makeLog(d.store);
		this.home = homeServer(d.servers.map((x) => x.server));
		this.homeAdapter = adapterOf(d.servers, this.home);
		this.decisionsThread = this.privateFile("decisions-thread");
		this.deskLane = deskLaneOf(this.homeAdapter);
		this.relay = this.makeRelay();
		this.outbox = this.makeOutbox();
		this.deliver = this.outbox.deliver;
		this.watchers = d.servers.map((x) => new Watcher(this, x.server, x.adapter));
		this.timing = { ...DEFAULT_RECOVER_TIMING, ...(typeof d.recover === "object" ? d.recover : {}) };
		this.judge = this.makeJudge();
		this.recovery = this.makeRecovery();
		const stewardNow = this.privateFile("steward-thread");
		if (stewardNow) this.EXCLUDE.add(stewardNow);
		this.rightsSent = openRightsSent(this.store, (e) =>
			this.log("rights-sent-unsaved", { error: String(e).slice(0, 200) }),
		);
		this.stewardCheck = this.makeStewardCheck();
		this.sweep = createSweep({
			store: this.store,
			log: this.log,
			outbox: this.outbox,
			conf: this.conf,
			privateFile: this.privateFile,
			sweepPromptFile: d.sweepPromptFile,
			watchers: this.watchers,
		});
		this.idleParents = this.makeIdleParents();
		this.heartbeat = this.makeHeartbeat();
		this.healthTick = this.makeHealthTick();
		this.usageTick = this.makeUsageTick();
	}

	// The daemon is the one relay (relay.ts): every process writes wakes as outbox rows, and only this sends them. Holdable wakes wait
	// while the Steward is busy and go as one digest (hold.ts).
	// The Alert Desk (alert-desk.ts), when the adapter has a desk thread, is a second RECEIVER of this one relay, never a second relay: its rows
	// (receiver "desk") go to its own transport and wait on its own gate, and every POST, the Steward's or the desk's, goes through the one
	// serial queue (relay.ts). A busy desk holds only its own wakes.
	protected makeRelay() {
		const { homeAdapter, deskLane } = this;
		return createRelay({
			store: this.store,
			lock: this.d.lock,
			wake: homeAdapter.wake,
			...(has(homeAdapter, "compact") ? { compact: homeAdapter.compact } : {}),
			gate: this.stewardGate,
			log: this.log,
			alarm: this.alarm,
			...this.d.relay,
			...(deskLane ? { receivers: { [DESK_RECEIVER]: { wake: deskLane.wake, gate: () => deskLane.isBusy() } } } : {}),
			rightsNow: () => this.rightsNow(),
			onDelivered: (id) => recordAnswerDelivered(this.store, id),
		});
	}

	protected makeOutbox() {
		return createOutbox({
			store: this.store,
			log: this.log,
			dry: this.DRY,
			...(this.d.relay?.now ? { now: this.d.relay.now } : {}),
			queued: () => {
				void this.relay.pass();
			},
		});
	}

	protected makeJudge(): Judge {
		const { d, conf, log } = this;
		const judge =
			d.judge ??
			createJudge({
				config: () => {
					const r = readJudgeConfig(conf);
					if (r.error) log("judge-config-error", { error: r.error });
					return r.config;
				},
				log,
			});
		// The judge's backend is an explicit setting (judge.json), with no default. Without one, recovery still retries once, and a second failure
		// goes to the Steward unjudged: say so once, at start, so an operator who expected a verdict can see why there is none.
		if (!d.judge && d.recover !== undefined && d.recover !== false) {
			const off = judgeOff(readJudgeConfig(conf).config, "stalled-recovery");
			if (off) log("judge-off", { trigger: "stalled-recovery", why: off });
		}
		return judge;
	}

	/** Running children and subagents of a thread, as recovery counts them. */
	protected async recoveryChildren(id: string): Promise<number> {
		const w = this.watcherOf(id);
		return w ? w.liveChildren(id) + (await w.subagents(id).catch(() => 0)) : 0;
	}

	/** The id of a thread's latest instruction, "none" when it has none, "unknown" when it cannot be read. */
	protected async recoveryInstructionId(id: string): Promise<string> {
		const w = this.watcherOf(id);
		if (!w) return "unknown";
		const r = await w.instructionRead(id);
		return r.state === "complete" ? (lastInstruction(r.items)?.id ?? "none") : "unknown";
	}

	protected makeRecovery(): Recovery | undefined {
		const { d } = this;
		if (d.recover === undefined || d.recover === false) return undefined;
		return createRecovery({
			store: {
				load: () => this.store.state.get<RecoverState>(RECOVER_KEY),
				save: (s) => this.store.state.set(RECOVER_KEY, s),
			},
			look: async (id) => this.watcherOf(id)?.adapter.inspect?.look?.(id),
			stewardId: () => this.privateFile("steward-thread"),
			decisionsId: () => this.privateFile("decisions-thread"),
			state: (id) => this.watcherOf(id)?.states.get(id),
			children: (id) => this.recoveryChildren(id),
			readFailure: async (id) => this.watcherOf(id)?.adapter.inspect?.failure?.(id),
			instructionId: (id) => this.recoveryInstructionId(id),
			ping: async (id, text, seed) => {
				const a = this.watcherOf(id)?.adapter;
				return a && has(a, "send")
					? a.send(id, text, seed, "daemon")
					: { ok: false, detail: "no adapter can send to this thread" };
			},
			judge: (trigger, brief) => this.judge(trigger, brief),
			wake: (id, _kind, note) => this.watcherOf(id)?.forceFailedWake(id, note),
			log: this.log,
			...(typeof d.recover === "object" ? { timing: d.recover } : {}),
		});
	}

	/** One pass of the once-a-minute housekeeping. The interval runs it; tests call it. */
	async tick() {
		try {
			this.heartbeat();
		} catch (e) {
			this.log("heartbeat-error", { error: String(e) });
		}
		try {
			this.relay.audit();
		} catch (e) {
			this.log("relay-audit-error", { error: String(e).slice(0, 200) });
		}
		// The relay polls on its own; a pass here too costs nothing (passes are one at a time) and makes the heartbeat a full look.
		const checks: Promise<unknown>[] = [
			this.relay.pass(),
			this.stewardCheck().catch((e) => this.log("steward-check-error", { error: String(e) })),
			this.cardReconcileTick(),
			this.snoozeReturnTick(),
		];
		if (this.d.housekeeping !== false) this.housekeepingChecks(checks);
		await Promise.all(checks);
	}

	/** Starts the watchers and the heartbeat, then recovers what a dead process left. Resolves when every watcher has stopped. */
	start(): Promise<void> {
		if (this.started) return this.started;
		this.log("start", {
			servers: this.d.servers.map((x) => x.server.name),
			dry: this.DRY,
			excluded: [...this.EXCLUDE],
		});
		this.interval = setInterval(() => {
			this.tick().catch((e) => this.log("tick-error", { error: String(e) }));
		}, this.t.tickMs);
		// The relay starts beside the watchers: its first pass sends whatever a dead process left pending.
		this.relay.start().then(() => this.log("startup-recovered"));
		this.recovery?.restore();
		this.started = Promise.all(this.watchers.map((w) => w.run())).then(() => undefined);
		return this.started;
	}

	async stop() {
		clearInterval(this.interval);
		await this.relay.stop();
		for (const w of this.watchers) w.stop();
		this.recovery?.stop();
		await this.started;
	}
}

export function createEngine(d: EngineDeps) {
	const core = new Core(d);
	return {
		start: () => core.start(),
		stop: () => core.stop(),
		tick: () => core.tick(),
		relay: core.relay,
		outbox: core.outbox,
		watchers: core.watchers,
		stewardGate: core.stewardGate,
		alarm: core.alarm,
		log: core.log,
		notified: () => new Set(core.store.items.list({ source: NOTIFICATION_LOG }).map((i) => i.dedupKey)),
	};
}
