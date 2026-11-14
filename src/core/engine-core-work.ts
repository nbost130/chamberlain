/** The engine's core, third layer: the tickers it builds and the housekeeping passes they run. */

import { has } from "./adapter-conformance.ts";
import { drainAlertDesk } from "./alert-desk.ts";
import { inboxPath } from "./alert-desk-config.ts";
import { reconcileCardHolds, trackUnverified, unverifiedAlarm } from "./card-reconcile.ts";
import { compactTokens } from "./config.ts";
import { CoreRights } from "./engine-core-rights.ts";
import { createHeartbeat } from "./engine-heartbeat.ts";
import { createIdleParents } from "./engine-idle.ts";
import { createStewardCheck } from "./engine-steward.ts";
import { clip, closeCardCommand } from "./engine-support.ts";
import { reconcileItemHolds, reconcileRefHolds } from "./hold-reconcile.ts";
import { obsFor } from "./log.ts";
import { alarms } from "./messages.ts";
import { announceReturns } from "./snooze.ts";
import { type Health, handoffDeliveryId, handoffWakeMessage, liveHealth } from "./steward-health.ts";
import { HEALTH_CONFIG } from "./steward-health-config.ts";
import { healthTicker } from "./steward-health-ticker.ts";
import { usageTicker } from "./steward-tokens.ts";

export abstract class CoreWork extends CoreRights {
	protected makeStewardCheck() {
		return createStewardCheck({
			privateFile: this.privateFile,
			exclude: this.EXCLUDE,
			probe: this.probe,
			rightsSent: this.rightsSent,
			compactReady: () => this.relay.compactReady(),
			compact: (id) => this.relay.compact(id),
			log: this.log,
			alarm: this.alarm,
			raiseAlarm: this.raiseAlarm,
			dry: this.DRY,
			compactAt: this.d.compactAt ?? compactTokens(HEALTH_CONFIG.compactContext),
			onDecisionsThread: (id) => {
				this.decisionsThread = id;
			},
		}).check;
	}

	// Its own timer, apart from the routine sweep's. Threads that are Chamberlain's own, or the operator's exclude list, are never idle parents.
	protected makeIdleParents() {
		const { d } = this;
		return createIdleParents({
			store: this.store,
			log: this.log,
			outbox: this.outbox,
			conf: this.conf,
			sources: () => this.watchers.map((w) => w.idleSource()),
			skip: () =>
				new Set(
					[
						...this.EXCLUDE,
						this.privateFile("steward-thread"),
						this.privateFile("decisions-thread"),
						this.privateFile("desk-thread"),
					].filter((x): x is string => Boolean(x)),
				),
			...(d.relay?.now ? { now: d.relay.now } : {}),
			...(d.classifierProvider ? { provider: d.classifierProvider } : {}),
		});
	}

	protected makeHeartbeat() {
		return createHeartbeat({
			store: this.store,
			watchers: this.watchers,
			failures: () => this.relay.failures(),
			mayBeOffline: (name) => this.d.servers.find((x) => x.server.name === name)?.server.mayBeOffline,
			raiseAlarm: this.raiseAlarm,
			logCounts: () => {
				const obs = obsFor(this.store);
				return { warn: obs.levels.warn, error: obs.levels.error, ...obs.counters };
			},
		}).beat;
	}

	protected makeHealthTick() {
		const adapter = this.homeAdapter;
		if (!has(adapter, "transcriptPath")) return undefined;
		const ask = this.d.ask;
		return healthTicker({
			store: this.store,
			server: () => this.home.name,
			collect: () => liveHealth(() => adapter.transcriptPath()),
			...(ask ? { ask } : {}),
			// A HAND OFF verdict starts the hand-off itself when the adapter says how: a wake, as an outbox row like any other, so the relay's attempts and dead-letter rules apply. Without that capability the operator is asked.
			...(has(adapter, "handoffInstruction")
				? {
						handoff: (h: Health, session: string) => {
							this.outbox.deliver(handoffWakeMessage(h, adapter.handoffInstruction()), handoffDeliveryId(session), {
								kind: "handoff",
							});
						},
					}
				: {}),
		});
	}

	protected makeUsageTick() {
		const adapter = this.homeAdapter;
		return this.d.stewardTokens && has(adapter, "transcriptPath")
			? usageTicker({ store: this.store, find: () => adapter.transcriptPath() })
			: undefined;
	}

	/** Snoozed questions whose time has come (src/core/snooze.ts): recorded once, and an urgent one is shown where the operator reads again. */
	protected snoozeReturnTick(): Promise<void> {
		return announceReturns({
			store: this.store,
			now: this.d.relay?.now?.() ?? Date.now(),
			dry: this.DRY,
			log: this.log,
			adapter: this.homeAdapter,
			post: this.d.post ?? ((item, adapter) => adapter.post(item, {})),
		});
	}

	protected async holdReconcileTick() {
		try {
			const { closed } = reconcileItemHolds(this.store);
			if (closed) this.log("held-closed-for-item", { closed, by: "reconciler" });
		} catch (e) {
			this.log("held-reconcile-error", { pass: "items", error: String(e).slice(0, 200) });
		}
		if (this.reconcilingRefs) return;
		this.reconcilingRefs = true;
		try {
			const r = await reconcileRefHolds({
				store: this.store,
				...(this.d.gh ? { gh: this.d.gh } : {}),
				snapshots: this.freshSnapshots,
			});
			if (r.ran && (r.closed || r.errors)) this.log("held-reconciled", { ...r });
		} catch (e) {
			this.log("held-reconcile-error", { pass: "refs", error: String(e).slice(0, 200) });
		} finally {
			this.reconcilingRefs = false;
		}
	}

	/** A server whose card reads fail is logged once per episode, and once more when they recover. */
	protected logCardReadEpisodes(r: Awaited<ReturnType<typeof reconcileCardHolds>>) {
		const failing = new Set(r.failed.map((f) => f.server));
		for (const f of r.failed)
			if (!this.cardReadFailing.has(f.server)) {
				this.cardReadFailing.set(f.server, f.reason);
				this.log("card-read-unavailable", { server: f.server, reason: f.reason });
			}
		for (const server of [...this.cardReadFailing.keys()])
			if (!failing.has(server)) {
				this.cardReadFailing.delete(server);
				this.log("card-read-recovered", { server });
			}
	}

	/** A card with no evidence for `cardUnverifiedAlarmMs` raises an alarm naming its hold, the card and the hand close command. */
	protected alarmUnverifiedCards(r: Awaited<ReturnType<typeof reconcileCardHolds>>) {
		for (const u of trackUnverified(this.store, r, this.t.cardUnverifiedAlarmMs)) {
			const a = unverifiedAlarm(u, closeCardCommand(u.card.server, u.card.requestId));
			this.log("card-unverified", {
				server: u.card.server,
				requestId: u.card.requestId,
				threadId: u.card.threadId ?? null,
				holds: u.card.holds.map((h) => h.id),
				reason: clip(u.reason, 200),
			});
			this.alarm(a.key, a.title, a.summary);
		}
	}

	protected async reconcileCards() {
		try {
			const r = await reconcileCardHolds(this.store, this.cardRead);
			for (const c of r.closed)
				this.log("card-reconciled", { server: c.server, threadId: c.threadId, requestId: c.requestId });
			this.logCardReadEpisodes(r);
			this.alarmUnverifiedCards(r);
		} catch (e) {
			this.log("held-reconcile-error", { pass: "cards", error: String(e).slice(0, 200) });
		}
	}

	/**
	 * Card holds against what their threads show (card-hold.ts `reconcileCardHolds`): every tick and on every (re)connection, so
	 * a card resolved while the daemon was down closes its question and hold, exactly once. A card closes ONLY on positive
	 * evidence: a read of its own thread on its own server (`WaitingRead` `ok: true`) that shows the card's own item in a
	 * terminal status (`resolved`). Absence closes nothing: a backend's read may be a bounded window of the thread's history, and
	 * a thread that is gone, archived or missing from a snapshot proves nothing; no snapshot is consulted. A server not connected
	 * now (a `mayBeOffline` one asleep included), a read that throws, is malformed or spans a disconnect, are all `ok: false`.
	 * A card with no evidence for `cardUnverifiedAlarmMs` raises an alarm (the normal repeat policy) naming its hold, the card
	 * and the hand close command; only the operator closes it then. A server whose reads fail is logged once per episode, and
	 * once more when they recover.
	 */
	cardReconcileTick(): Promise<void> {
		if (this.reconcilingCards) {
			this.cardsAgain = true;
			return this.reconcilingCards;
		}
		this.reconcilingCards = this.reconcileCards().finally(() => {
			this.reconcilingCards = undefined;
			if (this.cardsAgain) {
				this.cardsAgain = false;
				void this.cardReconcileTick();
			}
		});
		return this.reconcilingCards;
	}

	/** The Alert Desk's inbox, drained into the outbox; a failure is an alarm, and the inbox keeps what it holds. */
	protected drainDesk() {
		const { deskLane } = this;
		if (!deskLane) return;
		try {
			drainAlertDesk({
				store: this.store,
				outbox: this.outbox,
				inbox: inboxPath(process.env, process.env.HOME ?? ""),
				conf: this.conf,
				now: this.d.relay?.now?.() ?? Date.now(),
				canDeliver: !this.DRY && deskLane.wake.ready(),
				log: this.log,
			});
		} catch (e) {
			this.log("alert-desk-error", { error: String(e).slice(0, 200) });
			this.alarm(
				"alert-desk",
				"chamberlain alert desk failed",
				"The Alert Desk drain threw an error and did not finish, so alerts are not reaching the desk thread this round. Its inbox keeps them.",
			);
		}
	}

	/** The checks of one housekeeping pass that run only when housekeeping is on, added to the pass's list in order. */
	protected housekeepingChecks(checks: Promise<unknown>[]) {
		const { log, healthTick, usageTick } = this;
		checks.push(this.holdReconcileTick());
		this.drainDesk();
		if (!this.DRY && healthTick)
			checks.push(healthTick().catch((e) => log("steward-health-error", { error: String(e) })));
		if (usageTick)
			checks.push(usageTick().catch((e) => log("steward-usage-error", { error: String(e).slice(0, 200) })));
		checks.push(this.idleParents.tick().catch((e) => log("idle-parents-error", { error: String(e).slice(0, 200) })));
		checks.push(
			this.sweep.tick().catch((e) => {
				log("sweep-error", { error: String(e) });
				this.raiseAlarm("sweep", alarms.sweepFailed());
			}),
		);
	}
}
