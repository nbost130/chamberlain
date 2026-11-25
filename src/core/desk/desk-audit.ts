/**
 * The Alert Desk after the fact: every finished turn's recorded calls, replayed through the same allowlist its hook runs. The preflight keeps
 * wakes off a desk that nothing limits; this says when something ran anyway, on any backend that records calls. It reports counts and turn ids,
 * never a command, a path or an alert's text. It blocks nothing.
 */
import type { DeskCall, DeskTurn, ReadDeskTurns } from "../adapter/adapter-desk.ts";
import type { Log } from "../log.ts";
import { alarms } from "../messages.ts";
import type { Store } from "../store/store.ts";

const KEY = "desk-audit";
const TURNS_PER_PASS = 20;
/** A gatherer's turn and its records can reach the record a little after they finish: a turn is judged once it has settled. */
const SETTLE_MS = 2 * 60_000;
type Cursor = { at: string; id: string };
/** The allowlist's verdict on one call, with the environment the installed hook has. */
export type DeskCheck = (call: DeskCall, env: Record<string, string>) => boolean;

type Deps = {
	store: Store;
	read: ReadDeskTurns;
	check: DeskCheck;
	alarm: (key: string, title: string, summary: string) => void;
	log: Log;
	now: () => number;
};

function allowed(check: DeskCheck, call: DeskCall, env: Record<string, string>): boolean {
	try {
		return check(call, env);
	} catch {
		return false;
	}
}

function auditTurn(d: Deps, turn: DeskTurn, env: Record<string, string>): void {
	const outside = turn.ran.filter((call) => !allowed(d.check, call, env)).length;
	if (outside) {
		const a = alarms.deskOutsideAllowlist(outside, turn.ran.length);
		d.alarm(`${KEY}:${turn.id}`, a.title, a.summary);
	}
	d.log("desk-audited", {
		ran: turn.ran.length,
		outside,
		refused: turn.refused,
		unreadable: turn.unreadable,
		complete: turn.items > 0 && turn.unreadable === 0,
	});
}

/** One pass. The first ever starts from now: what a desk did before this build is not judged. */
export function deskAuditPass(d: Deps): void {
	const cursor = d.store.state.get<Cursor>(KEY);
	if (!cursor) {
		d.store.state.set(KEY, { at: new Date(d.now()).toISOString(), id: "" } satisfies Cursor);
		return;
	}
	const batch = d.read({ after: cursor, until: new Date(d.now() - SETTLE_MS).toISOString(), limit: TURNS_PER_PASS });
	if (!batch) {
		if (!d.store.state.get<boolean>(`${KEY}-blind`)) {
			d.store.state.set(`${KEY}-blind`, true);
			d.log("desk-audit-unavailable", {});
		}
		return;
	}
	if (d.store.state.get<boolean>(`${KEY}-blind`)) d.store.state.delete(`${KEY}-blind`);
	for (const turn of batch.turns) {
		auditTurn(d, turn, batch.env);
		d.store.state.set(KEY, { at: turn.at, id: turn.id } satisfies Cursor);
	}
}
