import { has } from "../adapter/adapter-conformance.ts";
import type { StewardProbe } from "../adapter/adapter-inspect.ts";
import { contextGuardConfig } from "../config/layout.ts";
import { guardedHealth, type Health, handoffDeliveryId, handoffWakeMessage } from "../steward/steward-health.ts";
import { healthTicker } from "../steward/steward-health-ticker.ts";
import { turnUsageTicker, usageTicker } from "../steward/steward-tokens.ts";
import { guardedThreads, stewardFallback } from "./engine-context-guard.ts";
import { CoreRights } from "./engine-core-rights.ts";
import { COMPACT_STATE_KEY, type CompactState, createStewardCheck } from "./engine-steward.ts";

export abstract class CoreSteward extends CoreRights {
	private contextFallback?: ReturnType<typeof stewardFallback>;

	private stewardContext(probe: StewardProbe | undefined) {
		const key = "steward-context-sample";
		const prior = this.store.state.get<{ session: string; reading: StewardProbe["lastMeasuredContext"] }>(key);
		const { contextSession: session, context: reading, contextPending } = probe ?? {};
		if (session && reading && "tokens" in reading && !contextPending && prior?.reading?.at !== reading.at)
			this.store.state.set(key, { session, reading });
		return prior && prior.session === session ? prior.reading : undefined;
	}

	protected makeStewardCheck() {
		const { steward: policy, threads } = contextGuardConfig(this.conf, this.d.compactAt);
		const guard = { store: this.store, policy, alarm: this.alarm };
		const fallback = stewardFallback(guard, () => this.store.state.get<CompactState>(COMPACT_STATE_KEY));
		this.contextFallback = fallback;
		const checkThreads = guardedThreads(
			{ ...guard, adapter: this.homeAdapter, log: this.log, dry: this.DRY, canOperate: () => this.d.lock.held() },
			threads,
		);
		const { check } = createStewardCheck({
			privateFile: this.privateFile,
			exclude: this.EXCLUDE,
			probe: () => {
				const probe = this.homeAdapter.stewardProbe?.(undefined, Math.max(policy.unknownTurns, policy.handoffTurns));
				this.stewardContext(probe);
				return probe;
			},
			rightsSent: this.rightsSent,
			compactReady: () => this.relay.compactReady(),
			compact: (id) => this.relay.compact(id),
			log: this.log,
			alarm: this.alarm,
			raiseAlarm: this.raiseAlarm,
			dry: this.DRY,
			compactAt: policy.compactAt,
			compactShare: policy.share,
			fallback: fallback.check,
			compactState: {
				get: () => this.store.state.get<CompactState>(COMPACT_STATE_KEY),
				set: (s) => this.store.state.set(COMPACT_STATE_KEY, s),
			},
			onDecisionsThread: (id) => {
				this.decisionsThread = id;
			},
		});
		let running: Promise<void> | undefined;
		return () => {
			running ??= check()
				.then(() => checkThreads(this.privateFile("steward-thread")))
				.finally(() => {
					running = undefined;
				});
			return running;
		};
	}

	protected makeHealthTick() {
		const adapter = this.homeAdapter;
		if (!has(adapter, "transcriptPath") && !has(adapter, "stewardProbe")) return undefined;
		const ask = this.d.ask;
		const policy = contextGuardConfig(this.conf, this.d.compactAt).steward;
		return healthTicker({
			store: this.store,
			server: () => this.home.name,
			collect: () => {
				const thread = this.privateFile("steward-thread");
				const probe = this.probe();
				return guardedHealth({
					find: has(adapter, "transcriptPath") ? () => adapter.transcriptPath() : undefined,
					meter: thread && has(adapter, "stewardMeter") ? adapter.stewardMeter(thread, 0, true) : undefined,
					thread,
					probe,
					priorContext: this.stewardContext(probe),
					policy,
				});
			},
			contextHandoff: () => this.contextFallback?.get(),
			// A compaction that did not bring the context under the line is not repeated: the Steward is handed off instead (steward-health-ticker.ts).
			compactFailed: (h: Health) => {
				const s = this.store.state.get<CompactState>(COMPACT_STATE_KEY);
				return Boolean(s?.failed && s.thread === h.thread && (!s.session || s.session === h.contextSession));
			},
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
		if (this.d.stewardTokens && has(adapter, "stewardMeter")) {
			const tick = turnUsageTicker({
				store: this.store,
				thread: () => this.privateFile("steward-thread"),
				read: (id, since) => adapter.stewardMeter(id, since),
			});
			return async () => tick();
		}
		return this.d.stewardTokens && has(adapter, "transcriptPath")
			? usageTicker({ store: this.store, find: () => adapter.transcriptPath() })
			: undefined;
	}
}
