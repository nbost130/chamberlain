/**
 * Nathan 2026-11-16 wake thresholds for parked prepare-pr / no-mistakes runs.
 * One-way-door gates are the R89 path (Steward/decider, not the builder).
 */
export const ONE_WAY_DOOR_URGENT_MS = 60_000;
export const OTHER_GATE_WAKE_MS = 15 * 60_000;
// v1: running with no progress > 30m is log-only (no finding emitted).

/** Step names that count as the one-way-door review gate. */
export const isOneWayDoorStep = (step: string): boolean => /one-way-door/i.test(step);
