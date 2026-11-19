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
import type { Adapter, ThreadState } from "../adapter/adapter.ts";
import { has } from "../adapter/adapter-conformance.ts";
import type { WaitingItem, WaitingRead } from "../adapter/adapter-waiting.ts";
import type { ActiveHoldConfig } from "../config/active-hold-config.ts";
import { holdUntil, releaseVerdict, withNote } from "../decide/active-hold.ts";
import { routeNeedsInput } from "../decide/decide.ts";
import type { Question } from "../items/questions.ts";
import type { Log } from "../log.ts";
import { activeHoldNote } from "../messages.ts";
import type { Store } from "../store/store.ts";
import type { HeldItem, Parked } from "../store/store-wakes.ts";
import type { Watcher } from "./engine-watcher.ts";

type ActiveHoldDeps = {
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

/** How many times a pointer post that times out is tried: the hold is saved, so the post is all there is to retry. */
const POINTER_TRIES = 3;

/** Posts a held card's pointer question, trying again when a post times out; the daemon's own hold is already saved, so this never wakes anyone. */
function postPointers(d: ActiveHoldDeps, w: Watcher, live: ThreadState, filed: (Question | undefined)[]) {
	for (const q of filed)
		void (async () => {
			for (let n = 1; n <= POINTER_TRIES; n++)
				try {
					return await within(w.postPointer(live, q), d.readMs ?? READ_MS);
				} catch (e) {
					d.log("active-hold-error", { error: `pointer post try ${n}: ${String(e).slice(0, 160)}` });
				}
		})();
}

/** What a release does with one parked wake, card by card: the cards to hold for the principal's return, and whether any is left for the Steward. */
type Plan = { drop?: "answered" | "left"; held: WaitingItem[]; steward: boolean };

/** Pure: what one card's own evidence says to do with it (`planRelease`). */
function cardFate(
	id: string,
	live: ThreadState | undefined,
	read: WaitingRead | undefined,
	away: boolean,
): "left" | "answered" | "steward" | WaitingItem {
	const v = releaseVerdict({ requestIds: [id] }, live, read);
	if (v.act === "drop") return v.reason;
	const shown = read?.ok ? read.cards.find((c) => c.requestId === id) : undefined;
	return shown && routeNeedsInput([shown], true, away) === "hold" ? shown : "steward";
}

/**
 * Pure: a group of cards is split, and each card is routed or dropped on its OWN evidence (`releaseVerdict` for that request alone). A card shown
 * resolved is done; one shown waiting that only the principal can clear, while they are away, is held for their return (`routeNeedsInput`, as a
 * fresh card would be); every other card, a card missing from the bounded snapshot included, stays with the Steward, whose wake carries the group.
 * Nothing is held or dropped for a card on another card's evidence. A wake with no card ids is the thread's own.
 */
function planRelease(
	p: Pick<Parked, "requestIds">,
	live: ThreadState | undefined,
	read: WaitingRead | undefined,
	away: boolean,
): Plan {
	if (!p.requestIds.length) {
		const v = releaseVerdict(p, live, read);
		return v.act === "drop" ? { drop: v.reason, held: [], steward: false } : { held: [], steward: true };
	}
	const fates = p.requestIds.map((id) => cardFate(id, live, read, away));
	if (fates.includes("left")) return { drop: "left", held: [], steward: false };
	const held = fates.filter((f): f is WaitingItem => typeof f === "object");
	const steward = fates.includes("steward");
	return !steward && !held.length ? { drop: "answered", held, steward } : { held, steward };
}

/** The thread's cards, read with the same deadline as the activity read: a hung request must not hold up the card, nor any other. No read wakes the card. */
async function readCards(
	d: ActiveHoldDeps,
	w: Watcher | undefined,
	item: HeldItem,
	server: string,
): Promise<WaitingRead | undefined> {
	if (!w || !item.thread || !has(w.adapter, "inspect")) return undefined;
	return within(w.adapter.inspect.waiting(item.thread), d.readMs ?? READ_MS).catch((e) => {
		d.log("active-hold-unavailable", { server, threadId: item.thread, error: String(e).slice(0, 200) });
		return undefined;
	});
}

/**
 * Carries out a plan in ONE transaction: the cards held for the principal's return are saved, and the wake is released (or dropped, when no card
 * is left for the Steward). A card is the Steward's or held, never both and never neither. The pointer posts come after, and retry on their own.
 */
function apply(
	d: ActiveHoldDeps,
	c: {
		w: Watcher | undefined;
		live: ThreadState | undefined;
		item: HeldItem & { parked: Parked };
		plan: Plan;
		away: boolean;
	},
) {
	const { w, live, item, plan } = c;
	const p = item.parked;
	const now = d.now();
	const filed: (Question | undefined)[] = [];
	const done = d.store.tx(() => {
		if (w && live) for (const h of plan.held) filed.push(w.recordCardHold(live, h));
		if (!plan.steward) return d.store.wakes.dropParked(item.deliveryId);
		const also = plan.held.length
			? ` ${plan.held.length} of its cards are held for the principal's return instead: do not act on those.`
			: "";
		const text = withNote(item.message, activeHoldNote(p.lastWriteAt, now) + also);
		return d.store.wakes.unpark(item.deliveryId, now, text) !== undefined;
	});
	if (!done) return;
	if (w && live) {
		for (const h of plan.held) d.log("held-by-daemon", { server: p.server, threadId: live.id, kind: h.type });
		postPointers(d, w, live, filed);
	}
	const held = { server: p.server, held_ms: Math.max(0, now - item.queuedAt) };
	if (!plan.steward) return d.log("active-hold-dropped", { ...held, reason: plan.drop ?? "held-for-return" });
	d.log("active-hold-released", { ...held, reason: c.away ? "away" : "due" });
	d.nudge();
}

/** One parked wake, settled card by card (`planRelease`). Before its time only a drop acts: every card answered, or its thread gone. */
async function settle(d: ActiveHoldDeps, item: HeldItem & { parked: Parked }, away: boolean, due: boolean) {
	const w = d.watcher(item.parked.server);
	const live = item.thread ? w?.states.get(item.thread) : undefined;
	const read = await readCards(d, w, item, item.parked.server);
	const plan = planRelease(item.parked, live, read, Boolean(d.store.away.current()));
	if (due || plan.drop) apply(d, { w, live, item, plan, away });
}

/**
 * Settles the parked cards: those whose time has come (all of them while the principal is away) are released or dropped; one not yet due is
 * dropped as soon as it is answered or its thread is gone, and otherwise left alone. Each card is settled on its own, side by side: one that
 * fails (a read that hangs, a write that throws) is logged and tried again next tick, and holds up none of the others.
 */
async function settleDue(d: ActiveHoldDeps) {
	let items: (HeldItem & { parked: Parked })[];
	let away: boolean;
	try {
		away = Boolean(d.store.away.current());
		items = d.store.wakes.parked(null).flatMap((i) => (i.parked ? [{ ...i, parked: i.parked }] : []));
	} catch (e) {
		d.log("active-hold-error", { error: String(e).slice(0, 200) });
		return;
	}
	const now = d.now();
	await Promise.all(
		items.map((item) =>
			settle(d, item, away, away || now >= item.parked.releaseAt).catch((e) =>
				d.log("active-hold-error", { error: String(e).slice(0, 200) }),
			),
		),
	);
}

function createActiveHold(d: ActiveHoldDeps) {
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
