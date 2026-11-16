/**
 * Size-capped digest composition for held ordinary wakes (turn_ended, sweep, alert_desk).
 * Lives apart from hold.ts so hold.ts does not import steward-types (import-cycle guard).
 */
import { exceedsEncodedCap, TRANSFER_DIGEST_MAX_BYTES } from "../steward/steward-types.ts";
import type { HeldItem } from "../store/store-wakes.ts";
import { composeWake } from "./hold.ts";

/**
 * Compose held ordinary wakes into one digest, capping count and UTF-8 encoded size of the
 * final send message (composeWake body + delivery-id trailer). An item that alone exceeds the
 * byte cap is never admitted; callers dead-letter it. Overflow that would break the bound stays held.
 */
export function composeDigestBatch(
	held: HeldItem[],
	now: number,
	maxBytes = TRANSFER_DIGEST_MAX_BYTES,
): ReturnType<typeof composeWake> | undefined {
	const sorted = [...held].filter((h) => h.kind !== "transfer").sort((a, b) => a.queuedAt - b.queuedAt);
	if (!sorted.length) return undefined;
	const batch: HeldItem[] = [];
	for (const item of sorted) {
		const next = [...batch, item];
		const trial = composeWake(next, now);
		if (exceedsEncodedCap(trial.message, trial.deliveryId, maxBytes)) {
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
