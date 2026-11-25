/**
 * The Alert Desk after the fact: every finished turn's recorded calls, replayed through the same allowlist its hook runs. The preflight keeps
 * wakes off a desk that nothing limits; this says when something ran anyway, on any backend that records calls. It reports counts and turn ids,
 * never a command, a path or an alert's text, and it blocks nothing. The rules are the ones in force when it runs, minutes after the turn.
 */
import type { DeskCall, DeskTurn, DeskTurnRef, DeskTurns } from "../adapter/adapter-desk.ts";
import type { Log } from "../log.ts";
import { alarms } from "../messages.ts";
import type { Store } from "../store/store.ts";

const KEY = "desk-audit";
/** How far back a pass looks, so a record that arrives late is still read. */
const WINDOW_MS = 6 * 60 * 60_000;
/** A turn is judged once it has settled. */
const SETTLE_MS = 2 * 60_000;
const LIST_MAX = 1_000;
/** Turns read in one pass. The rest wait for the next minute: a pass must not hold up a wake. */
const READ_MAX = 3;
type State = { since: string; judged: Record<string, { at: string; items: number }> };

/** Makes the allowlist's verdict for one pass, from the operator's settings as they are now and the installed hook's environment. */
export type DeskCheck = (env: Record<string, string>) => (call: DeskCall) => boolean;

type Deps = {
	store: Store;
	turns: DeskTurns;
	check: DeskCheck;
	alarm: (key: string, title: string, summary: string) => void;
	log: Log;
	now: () => number;
};

function allowed(check: (call: DeskCall) => boolean, call: DeskCall): boolean {
	try {
		return check(call);
	} catch {
		return false;
	}
}

/** Once per outage: the turns cannot be read. */
function blind(d: Deps, on: boolean): void {
	const key = `${KEY}-blind`;
	if (Boolean(d.store.state.get<boolean>(key)) === on) return;
	if (!on) {
		d.store.state.delete(key);
		return;
	}
	d.store.state.set(key, true);
	d.log("desk-audit-unavailable", {});
}

function judge(d: Deps, ref: DeskTurnRef, turn: DeskTurn, check: (call: DeskCall) => boolean): void {
	const outside = turn.ran.filter((call) => !allowed(check, call)).length;
	// Its key is the turn, so a crash before the state is saved raises it again as the same alarm.
	if (outside) {
		const a = alarms.deskOutsideAllowlist(outside, turn.ran.length);
		d.alarm(`${KEY}:${ref.id}`, a.title, a.summary);
	}
	d.store.tx(() => {
		const state = d.store.state.get<State>(KEY);
		if (!state) return;
		state.judged[ref.id] = { at: ref.at, items: ref.items };
		d.store.state.set(KEY, state);
		d.log("desk-audited", {
			ran: turn.ran.length,
			outside,
			refused: turn.refused,
			unreadable: turn.unreadable,
			complete: ref.items > 0 && turn.unreadable === 0,
		});
	});
}

/** Nothing before `since` is judged, and what was judged before the window is forgotten with it. */
function pruned(state: State, windowStart: string): { state: State; after: string } {
	const after = state.since > windowStart ? state.since : windowStart;
	const judged = Object.fromEntries(Object.entries(state.judged).filter(([, j]) => j.at > after));
	return { state: { since: state.since, judged }, after };
}

/** One pass. The first ever starts from now: what a desk did before this build is not judged. */
export function deskAuditPass(d: Deps): void {
	const now = d.now();
	const iso = (t: number) => new Date(t).toISOString();
	const saved = d.store.state.get<State>(KEY);
	if (!saved) {
		d.store.state.set(KEY, { since: iso(now), judged: {} } satisfies State);
		return;
	}
	const { state, after } = pruned(saved, iso(now - WINDOW_MS));
	if (Object.keys(state.judged).length !== Object.keys(saved.judged).length) d.store.state.set(KEY, state);
	const refs = d.turns.list({ after, until: iso(now - SETTLE_MS), limit: LIST_MAX });
	if (!refs || refs.length === LIST_MAX) {
		blind(d, true);
		if (!refs) return;
	}
	const due = refs.filter((ref) => (state.judged[ref.id]?.items ?? -1) < ref.items).slice(0, READ_MAX);
	const check = due.length ? d.check(d.turns.env()) : () => false;
	let unread = refs.length === LIST_MAX;
	for (const ref of due) {
		const turn = d.turns.read(ref);
		if (turn) judge(d, ref, turn, check);
		else unread = true;
	}
	blind(d, unread);
}
