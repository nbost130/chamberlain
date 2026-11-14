/** What the engine's watchers, relay and tickers share, first layer: the world's state, alarms and the notification ledger. */
import { execFile } from "node:child_process";
import type { Adapter } from "./adapter.ts";
import { has } from "./adapter-conformance.ts";
import type { CardThreadRead } from "./card-reconcile.ts";
import { alertCommand } from "./config.ts";
import { LIVE } from "./decide.ts";
import type { createOutbox } from "./deliver.ts";
import type { createIdleParents } from "./engine-idle.ts";
import { type deskLaneOf, type EngineDeps, type EngineTiming, TOKEN_ALARM_WINDOW_MS } from "./engine-support.ts";
import type { createSweep } from "./engine-sweep.ts";
import type { Watcher } from "./engine-watcher.ts";
import type { Gate } from "./hold.ts";
import { takeSnapshots } from "./hold-threads.ts";
import type { Judge } from "./judge.ts";
import { readNamed } from "./layout.ts";
import type { Log } from "./log.ts";
import { type AlarmText, alarms } from "./messages.ts";
import { NOTIFICATION_LOG, repeatEvery } from "./notification.ts";
import type { Outcome, Recovery } from "./recover.ts";
import type { RecoverTiming } from "./recover-classify.ts";
import type { Relay } from "./relay.ts";
import type { openRightsSent } from "./rights-sent.ts";
import type { ServerEntry } from "./servers.ts";
import type { Store } from "./store.ts";

/** Everything the engine's watchers, relay and tickers share: one world per engine, built in the order its pieces need each other. */
export abstract class CoreBase {
	protected abstract readonly d: EngineDeps;
	abstract readonly conf: string;
	abstract readonly store: Store;
	abstract readonly DRY: boolean;
	abstract readonly t: EngineTiming;
	abstract readonly EXCLUDE: Set<string>;
	abstract readonly log: Log;
	abstract readonly home: ServerEntry;
	abstract readonly homeAdapter: Adapter;
	/**
	 * Keys a fire has decided to notify but not yet committed. They are written with the wake's outbox row, in one transaction,
	 * never before it: a crash between a recorded notification and its wake would suppress the alert for good. Until then the
	 * set keeps a second fire from deciding the same thing, and it is released when the fire ends, committed or not.
	 */
	readonly staged = new Set<string>();
	decisionsThread: string | undefined;
	recovery: Recovery | undefined;
	abstract readonly deskLane: ReturnType<typeof deskLaneOf>;
	abstract readonly relay: Relay;
	abstract readonly outbox: ReturnType<typeof createOutbox>;
	abstract readonly deliver: ReturnType<typeof createOutbox>["deliver"];
	abstract readonly watchers: Watcher[];
	abstract readonly timing: RecoverTiming;
	protected abstract readonly judge: Judge;
	protected abstract readonly rightsSent: ReturnType<typeof openRightsSent>;
	protected abstract readonly stewardCheck: () => Promise<void>;
	protected abstract readonly sweep: ReturnType<typeof createSweep>;
	protected abstract readonly idleParents: ReturnType<typeof createIdleParents>;
	protected abstract readonly heartbeat: () => void;
	protected abstract readonly healthTick: (() => Promise<unknown>) | undefined;
	protected abstract readonly usageTick: (() => Promise<unknown>) | undefined;
	protected reconcilingRefs = false;
	protected reconcilingCards: Promise<void> | undefined;
	/** Asked for while a pass ran: that pass may have read before the change, so one more runs after it. */
	protected cardsAgain = false;
	/** Servers whose card reads are failing now, with the first reason: one log line per episode. */
	protected readonly cardReadFailing = new Map<string, string>();
	protected interval: ReturnType<typeof setInterval> | undefined;
	protected started: Promise<void> | undefined;
	/** Dead-man alarms: a silent stop must become a loud one. An alarm is an item that re-notifies every 6 hours while it keeps being raised. */
	protected readonly alarmRepeat = repeatEvery(TOKEN_ALARM_WINDOW_MS);
	privateFile = (name: string) => readNamed(this.conf, name);
	/**
	 * Which wakes already went out is the item system's: a "notification-log" item per dedup key, notified once (Alertmanager
	 * keeps the same record, its notification log). There is no other record of it.
	 */
	readonly notified = {
		has: (dedupKey: string) =>
			this.staged.has(dedupKey) || (this.store.items.get(NOTIFICATION_LOG, dedupKey)?.notificationCount ?? 0) > 0,
	};
	/** Writes the notification-log item. Only ever called inside the transaction that also writes the wake's outbox row (see `commit` in deliver.ts). */
	markNotified = (dedupKey: string): boolean =>
		this.store.items.observe({ source: NOTIFICATION_LOG, kind: "sent", dedupKey }).notify;
	/** Raises an alarm whose words are in messages.ts. */
	raiseAlarm = (key: string, a: AlarmText) => this.alarm(key, a.title, a.summary);
	alarm = (key: string, title: string, summary: string) => {
		if (
			!this.store.items.observe({
				source: "alarm",
				kind: "alarm",
				dedupKey: key,
				repeat: this.alarmRepeat,
				payload: { title },
			}).notify
		)
			return;
		this.log("alarm", { key, title });
		if (this.DRY) return;
		// An alert command is the operator's own (settings.json `alertCommand`): it gets `warning <title> <summary>`.
		const cmd = alertCommand();
		if (!cmd) return;
		const env = { ...process.env, CHAMBERLAIN_ALARM_KEY: key };
		if (this.d.alert) {
			this.d.alert(cmd, ["warning", title, summary], env);
			return;
		}
		execFile(cmd, ["warning", title, summary], { timeout: 30000, env }, (err) => {
			if (err) this.log("alarm-emit-failed", { key, error: String(err.message).slice(0, 200) });
		});
	};
	/**
	 * Whether the Steward can take a wake without it queueing behind another turn: the backend's own record of its thread
	 * (`Adapter.isBusy`), and, while a watcher is connected, the thread's live status from it. The queue server reads the
	 * backend alone, so the two agree whenever the stream is quiet. No Steward thread, nothing to wait for.
	 */
	stewardGate = (): Gate => {
		const id = this.privateFile("steward-thread");
		if (!id) return "idle";
		const live = this.watchers.some((w) => w.connected && LIVE.has(w.states.get(id)?.status ?? ""));
		return live ? "busy" : this.homeAdapter.isBusy();
	};
	watcherOf = (threadId: string) => this.watchers.find((w) => w.states.has(threadId));
	/** Raises a decision-queue item recovery asked for: the one outage alarm, or a verdict that needs the principal. With no queue wired, an outage falls back to the dead-man alarm. */
	raise = async (a: NonNullable<Outcome["ask"]>) => {
		this.log(a.why === "breaker" ? "recover-breaker-alarm" : "recover-ask", { kind: a.kind, count: a.count });
		if (this.d.ask)
			await this.d.ask(a.item).catch((e) => this.log("recover-ask-failed", { error: String(e).slice(0, 200) }));
		else if (a.why === "breaker")
			this.raiseAlarm(
				`recover-breaker:${a.kind}`,
				alarms.recoverBreaker(a.kind, a.count, Math.round(this.timing.breakerWindowMs / 60_000)),
			);
	};
	/** The Steward's context size from the adapter's probe, when it has one. */
	probe = () => (has(this.homeAdapter, "stewardProbe") ? this.homeAdapter.stewardProbe() : undefined);
	/**
	 * The held ledger's reconciler (src/core/hold-reconcile.ts). Items: every tick, database only. Refs: every ten minutes,
	 * against GitHub and the watchers' thread tables.
	 */
	/** A fresh snapshot of every server, taken now through its adapter. An adapter that cannot take one reads as unreachable: its threads stay unknown. */
	protected freshSnapshots = () =>
		takeSnapshots(
			this.d.servers.map((x) => ({
				name: x.server.name,
				fetch: async () => {
					if (!has(x.adapter, "snapshot")) throw Error("no snapshot capability");
					return x.adapter.snapshot();
				},
			})),
		);
	/** What a card's thread shows, for the card reconciler: its own server's read, or why there is none. */
	protected cardRead = async (server: string, threadId: string): Promise<CardThreadRead> => {
		const w = this.watchers.find((x) => x.srv.name === server);
		if (!w) return { ok: false, reason: `no watcher for ${server}` };
		if (!has(w.adapter, "inspect")) return { ok: false, reason: `${server} has no inspect capability` };
		if (!w.connected) return { ok: false, reason: `${server} is not connected` };
		const r = await w.waitingRead(threadId);
		return r.ok
			? { ok: true, waiting: new Set(r.cards.map((i) => i.requestId)), resolved: new Set(r.resolved ?? []) }
			: { ok: false, reason: r.reason };
	};
}
