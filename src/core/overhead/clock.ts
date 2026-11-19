/**
 * The cooldown's clock, kept in Chamberlain's own state so a restart does not lose it. A reservation records the clock reading when it was made
 * (`openedClock`); how long it has been held is the SMALLER of the wall-clock difference and the difference of this clock's readings.
 *
 * The clock only ever advances by what a tick can vouch for: inside one process by the smaller of the wall and the monotonic step, and on the first
 * tick after a start (no earlier reading in this process, so a jump cannot be told from a long stop) by at most `RESTART_GAP_MS`. A wall clock that
 * jumps forward, in a process or across a restart, therefore adds a bounded step; one that goes backwards adds nothing and re-bases. Time while the
 * daemon is down is counted only up to that bound. Every error leaves the cooldown LONGER than it says, never shorter.
 */
import type { Store } from "../store/store.ts";
import { HOUR_MS } from "./config.ts";
import { type Clock, OVERHEAD_KEY, type OverheadState } from "./trigger.ts";

/** The most one tick adds to the clock when this process has no earlier reading. */
const RESTART_GAP_MS = HOUR_MS;

/**
 * Advances the persisted clock to `now` and returns it. `monoStep` is the monotonic clock's step since this process's previous tick, or undefined
 * on its first. A reading that is not a finite number adds nothing.
 */
export function advanceClock(store: Pick<Store, "state">, now: number, monoStep: number | undefined): Clock {
	let out: Clock = { at: now, ms: 0 };
	store.state.update<OverheadState>(OVERHEAD_KEY, (prior) => {
		const s = prior ?? { investigations: [] };
		const was = s.clock;
		const wall = was && Number.isFinite(was.at) && Number.isFinite(now) ? Math.max(0, now - was.at) : 0;
		const bound = monoStep === undefined ? RESTART_GAP_MS : Math.max(0, monoStep);
		const base = was && Number.isFinite(was.ms) ? was.ms : 0;
		out = { at: now, ms: base + Math.min(wall, Number.isFinite(bound) ? bound : 0) };
		return { ...s, clock: out };
	});
	return out;
}
