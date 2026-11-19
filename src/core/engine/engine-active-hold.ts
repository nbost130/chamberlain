/**
 * Active hold: a question card in a thread the principal is writing in waits for them before it wakes the Steward. A card is a request for
 * an answer, and a person who has just typed in the thread is usually the one about to give it: most such wakes found nothing to do. So
 * when a card is raised in a thread whose principal wrote within the window (`activeHold.windowMinutes`), the wake is parked in `held_wakes`
 * (store-wakes.ts `Parked`) until that message plus the window. This file does the two things the pure rules (decide/active-hold.ts) leave:
 * `plan` asks the adapter when the principal last wrote, and `tick` settles every parked card whose time has come, from the database alone,
 * so a restart loses none: a card past its time on boot is settled by the first tick, at once.
 *
 * Settled means: still waiting, the wake becomes an ordinary pending row with a note saying the principal had their window; answered
 * or gone, it is dropped and logged. Away mode releases every parked card at once (nobody is typing now). Never held: anything in the
 * Steward's own thread, the Decisions thread or the Alert Desk's, a card raised while the principal is away, and every message or answer.
 */
import type { Adapter } from "../adapter/adapter.ts";
import { has } from "../adapter/adapter-conformance.ts";
import type { ActiveHoldConfig } from "../config/active-hold-config.ts";
import { holdUntil, releaseVerdict, withNote } from "../decide/active-hold.ts";
import type { Log } from "../log.ts";
import { activeHoldNote } from "../messages.ts";
import type { Store } from "../store/store.ts";
import type { HeldItem, Parked } from "../store/store-wakes.ts";
import type { Watcher } from "./engine-watcher.ts";

export type ActiveHoldDeps = {
	store: Store;
	log: Log;
	config: ActiveHoldConfig;
	now: () => number;
	/** Thread ids that are never held: the Steward's, the Decisions thread, the Alert Desk's and the operator's exclude list. */
	skip: () => ReadonlySet<string>;
	watcher: (server: string) => Watcher | undefined;
	/** Tells the relay a row is pending. */
	nudge: () => void;
	/** How long the principal-activity read may take before the card goes out as if the principal were not there. Default 5 seconds. */
	readMs?: number | undefined;
};

/** The longest the activity read is waited for: a card that waits on a slow server is a wake that is late, which is what this feature must never cost. */
const READ_MS = 5000;

/** The read, or a rejection of `timeout` text when it takes longer than `ms`. The read itself is left to finish or fail on its own. */
function within<T>(read: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(Error(`timeout: no answer in ${ms} ms`)), ms);
	});
	return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

/** The longest a timer is set for: a nudge to tick near a card's time, never the thing that releases it. */
const NUDGE_MAX_MS = 15 * 60_000;

/**
 * The record to park a card under, or undefined when its wake goes out at once: the feature is off, the principal is away, the thread is
 * one of Chamberlain's own, the adapter cannot say when the principal wrote, the read failed, or they did not write within the window.
 */
async function plan(
	d: ActiveHoldDeps,
	{ thread, server, adapter, requestIds }: { thread: string; server: string; adapter: Adapter; requestIds: string[] },
): Promise<Parked | undefined> {
	const { config } = d;
	if (!config.enabled || d.store.away.current() || d.skip().has(thread)) return undefined;
	if (!has(adapter, "inspect") || !adapter.inspect.principalLastWrite) return undefined;
	const now = d.now();
	let last: number | undefined;
	try {
		last = await within(adapter.inspect.principalLastWrite(thread, now - config.windowMs), d.readMs ?? READ_MS);
	} catch (e) {
		// Fail open: with no word on the principal the card wakes the Steward at once, exactly as it did before this feature existed.
		d.log("active-hold-unavailable", { server, threadId: thread, error: String(e).slice(0, 200) });
		return undefined;
	}
	const releaseAt = holdUntil(last, now, config.windowMs);
	return releaseAt === undefined || last === undefined
		? undefined
		: { releaseAt, lastWriteAt: last, server, requestIds };
}

/** One parked card: dropped when it is answered or its thread is gone; else, when due, released as an ordinary wake with the note. */
async function settle(d: ActiveHoldDeps, item: HeldItem & { parked: Parked }, away: boolean, due: boolean) {
	const p = item.parked;
	const w = d.watcher(p.server);
	const live = item.thread ? w?.states.get(item.thread) : undefined;
	const read =
		w && item.thread && has(w.adapter, "inspect")
			? await w.adapter.inspect.waiting(item.thread).catch(() => undefined)
			: undefined;
	const verdict = releaseVerdict(p, live, read);
	const now = d.now();
	const held = { server: p.server, held_ms: Math.max(0, now - item.queuedAt) };
	if (verdict.act === "drop") {
		if (d.store.wakes.dropParked(item.deliveryId)) d.log("active-hold-dropped", { ...held, reason: verdict.reason });
		return;
	}
	// Not yet due and still waiting: it stays parked until its time.
	if (!due) return;
	const text = withNote(item.message, activeHoldNote(p.lastWriteAt, now));
	if (!d.store.wakes.unpark(item.deliveryId, now, text)) return;
	d.log("active-hold-released", { ...held, reason: away ? "away" : "due" });
	d.nudge();
}

/**
 * Settles the parked cards: those whose time has come (all of them while the principal is away) are released or dropped; one not yet due is
 * dropped as soon as it is answered or its thread is gone, and otherwise left alone. A failure is logged and the next tick tries again.
 */
async function settleDue(d: ActiveHoldDeps) {
	try {
		const away = Boolean(d.store.away.current());
		const now = d.now();
		for (const item of d.store.wakes.parked(null))
			if (item.parked) await settle(d, { ...item, parked: item.parked }, away, away || now >= item.parked.releaseAt);
	} catch (e) {
		d.log("active-hold-error", { error: String(e).slice(0, 200) });
	}
}

export function createActiveHold(d: ActiveHoldDeps) {
	let ticking: Promise<void> | undefined;
	const timers = new Set<ReturnType<typeof setTimeout>>();
	/** One pass at a time; a call while one runs joins it. */
	const tick = (): Promise<void> => {
		ticking ??= settleDue(d).finally(() => {
			ticking = undefined;
		});
		return ticking;
	};
	return {
		plan: (thread: string, server: string, adapter: Adapter, requestIds: string[]) =>
			plan(d, { thread, server, adapter, requestIds }),
		/** Logged when the card was parked; asks for a tick near its time so the wait is not a whole tick longer than the window. */
		parked(p: Parked) {
			const wait = Math.max(0, p.releaseAt - d.now());
			d.log("active-hold-held", { server: p.server, forMs: wait });
			const t = setTimeout(
				() => {
					timers.delete(t);
					void tick();
				},
				Math.min(NUDGE_MAX_MS, wait + 50),
			);
			t.unref?.();
			timers.add(t);
		},
		tick,
		stop() {
			for (const t of timers) clearTimeout(t);
			timers.clear();
		},
	};
}
export type ActiveHold = ReturnType<typeof createActiveHold>;

/** The engine's core, as far as the active hold reads it: its store and log, its watchers and its relay. */
type HoldCore = { store: Store; log: Log; watchers: readonly Watcher[]; relay: { pass(): Promise<unknown> } };
/** The engine's deps the hold reads: its config and read deadline, and the clock tests inject. */
type HoldDeps = {
	activeHold?: ActiveHoldConfig | undefined;
	activeHoldReadMs?: number | undefined;
	relay?: { now?: (() => number) | undefined } | undefined;
};

/**
 * The engine's active hold: off (an engine given no `activeHold` never holds a card), on the relay's clock, reading the watchers by server
 * name. `skip` names Chamberlain's own threads; the Steward's current thread is added here.
 */
export function activeHoldFor(core: HoldCore, d: HoldDeps, skip: () => ReadonlySet<string>): ActiveHold {
	return createActiveHold({
		store: core.store,
		log: core.log,
		config: d.activeHold ?? { enabled: false, windowMs: 0 },
		now: () => d.relay?.now?.() ?? Date.now(),
		skip: () => new Set([...skip(), core.store.steward.current()?.thread ?? ""]),
		watcher: (server) => core.watchers.find((x) => x.srv.name === server),
		nudge: () => void core.relay.pass(),
		readMs: d.activeHoldReadMs,
	});
}
