/**
 * Size-capped digest composition for held ordinary wakes (turn_ended, sweep, alert_desk).
 * Lives apart from hold.ts so hold.ts does not import steward-types (import-cycle guard).
 */
import { exceedsEncodedCap, TRANSFER_DIGEST_MAX_BYTES } from "../steward/steward-types.ts";
import type { HeldItem } from "../store/store-wakes.ts";
import { composeWake, hasOwnCeiling } from "./hold.ts";

/**
 * Room a digest of several wakes leaves under the replay bound for the transfer header (steward-header.ts) that wraps it if the Steward is
 * switched before it is acknowledged: a digest the old Steward accepted must still fit once wrapped, or the new one never sees its members.
 * A lone wake is bounded by the full cap, as before (isOversizedHeldDigest), so no item that fits alone is left held for good.
 */
export const TRANSFER_WRAP_RESERVE_BYTES = 2048;

/**
 * Compose held ordinary wakes into one digest, capping count and UTF-8 encoded size of the
 * final send message (composeWake body + delivery-id trailer). An item that alone exceeds the
 * byte cap is never admitted; callers dead-letter it. Overflow that would break the bound stays held.
 * Wakes with a ceiling of their own (answers) are admitted first, so the deadline that forced the digest is never left out of it by older
 * wakes filling the budget; the digest's text still runs oldest first (composeWake sorts it).
 */
export function composeDigestBatch(
	held: HeldItem[],
	now: number,
	maxBytes = TRANSFER_DIGEST_MAX_BYTES,
): ReturnType<typeof composeWake> | undefined {
	const sorted = [...held]
		.filter((h) => h.kind !== "transfer")
		.sort((a, b) => Number(hasOwnCeiling(b)) - Number(hasOwnCeiling(a)) || a.queuedAt - b.queuedAt);
	if (!sorted.length) return undefined;
	const batch: HeldItem[] = [];
	for (const item of sorted) {
		const next = [...batch, item];
		const trial = composeWake(next, now);
		const cap = next.length > 1 ? maxBytes - TRANSFER_WRAP_RESERVE_BYTES : maxBytes;
		if (exceedsEncodedCap(trial.message, trial.deliveryId, cap)) {
			if (batch.length === 0) continue;
			break;
		}
		batch.push(item);
	}
	return batch.length ? composeWake(batch, now) : undefined;
}

/** True when a held ordinary wake alone exceeds the encoded replay bound (final send framing included). */
export function isOversizedHeldDigest(item: HeldItem, now: number, maxBytes = TRANSFER_DIGEST_MAX_BYTES): boolean {
	if (item.kind === "transfer") return false;
	const trial = composeWake([item], now);
	return exceedsEncodedCap(trial.message, trial.deliveryId, maxBytes);
}
