import { openRightsSent, rightsFor } from "../core/steward/rights-sent.ts";
import type { Store } from "../core/store/store.ts";

export const STEWARD = "steward-thread-1";

export const RULES = "decision rights text\nR-1 a ruling";

const MANDATE = "";

export const AT = "2026-11-13T18:00:00.000Z";

export const FULL = `Decision rights (standing rules):\n${RULES}`;

/** One daemon process: the startup load, then one wake that lands. */
export function daemonWake(
	store: Store,
	used: number | undefined,
	o: { steward?: string; rules?: string; mandate?: string; now?: string; compactions?: number } = {},
) {
	const ledger = openRightsSent(store);
	const r = rightsFor(ledger.get(), {
		stewardId: o.steward ?? STEWARD,
		rules: o.rules ?? RULES,
		mandate: o.mandate ?? MANDATE,
		used,
		now: o.now ?? AT,
		...(o.compactions !== undefined ? { compactions: o.compactions } : {}),
	});
	ledger.set(r.record);
	return r.text;
}
