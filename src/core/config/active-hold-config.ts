/**
 * `activeHold` in config.json: whether a question card in a thread the principal is driving waits for them before it wakes the Steward, and for
 * how long. Pure and total: a missing section is the defaults, and anything else that is not valid is an error naming the key.
 */

export type ActiveHoldConfig = { enabled: boolean; windowMs: number };

/** The window the principal's last message keeps a card from waking the Steward, unless `activeHold.windowMinutes` says otherwise. */
export const DEFAULT_ACTIVE_HOLD_MINUTES = 5;
export const DEFAULT_ACTIVE_HOLD: ActiveHoldConfig = { enabled: true, windowMs: DEFAULT_ACTIVE_HOLD_MINUTES * 60_000 };
const KEYS = ["enabled", "windowMinutes"] as const;

/** The section's value as a config: `null` or `undefined` is the defaults; an unknown key, a non-boolean `enabled` or a non-positive window throws. */
export function parseActiveHold(raw: unknown): ActiveHoldConfig {
	if (raw === null || raw === undefined) return DEFAULT_ACTIVE_HOLD;
	if (typeof raw !== "object" || Array.isArray(raw)) throw Error('config.json: "activeHold" must be an object');
	const o = raw as Record<string, unknown>;
	const unknown = Object.keys(o).find((k) => !(KEYS as readonly string[]).includes(k));
	if (unknown) throw Error(`config.json: "activeHold.${unknown}" is not a setting (known: ${KEYS.join(", ")})`);
	if (o.enabled !== undefined && typeof o.enabled !== "boolean")
		throw Error('config.json: "activeHold.enabled" must be true or false');
	const m = o.windowMinutes;
	if (m !== undefined && (typeof m !== "number" || !Number.isFinite(m) || m <= 0))
		throw Error('config.json: "activeHold.windowMinutes" must be a positive number');
	return {
		enabled: o.enabled ?? DEFAULT_ACTIVE_HOLD.enabled,
		windowMs: (m ?? DEFAULT_ACTIVE_HOLD_MINUTES) * 60_000,
	};
}
