/** Dead-letter held wakes that alone exceed the encoded replay bound (transfer and ordinary digest). */

import { composeWake } from "../decide/hold.ts";
import { isOversizedHeldDigest } from "../decide/hold-digest-batch.ts";
import type { Ctx, Lane } from "../delivery/relay-ctx.ts";
import { raise } from "../delivery/relay-ctx.ts";
import { alarms } from "../messages.ts";
import type { Composed, HeldItem } from "../store/store-wakes.ts";
import { encodedSendBytes, exceedsEncodedCap, TRANSFER_DIGEST_MAX_BYTES } from "./steward-types.ts";

function isOversizedTransfer(item: HeldItem, now: number, maxBytes = TRANSFER_DIGEST_MAX_BYTES): boolean {
	if (item.kind !== "transfer") return false;
	const trial = composeWake([item], now);
	return exceedsEncodedCap(trial.message, trial.deliveryId, maxBytes);
}

type OversizedSoloHoldSpec = {
	filter: (item: HeldItem, now: number, maxBytes: number) => boolean;
	compose: (hit: HeldItem, now: number) => Composed;
	vanished: string;
	finishFail: string;
	log: string;
	alarmKey: string;
	alarm: (ids: string[], maxBytes: number) => { title: string; summary: string };
};

type OversizedSoloHoldJob = {
	r: Ctx;
	l: Lane;
	now: number;
	maxBytes: number;
	spec: OversizedSoloHoldSpec;
};

function deadLetterOversizedSoloHolds(job: OversizedSoloHoldJob): string[] {
	const { r, l, now, maxBytes, spec } = job;
	const oversized = r.store.wakes.held(l.name).filter((h) => spec.filter(h, now, maxBytes));
	const ids: string[] = [];
	for (const item of oversized) {
		if (!r.store.wakes.held(l.name).some((h) => h.deliveryId === item.deliveryId)) continue;
		try {
			const row = r.store.tx(() => {
				const composed = r.store.wakes.compose(
					now,
					(held) => {
						const hit = held.find((h) => h.deliveryId === item.deliveryId);
						if (!hit) throw new Error(`${spec.vanished}: ${item.deliveryId}`);
						return spec.compose(hit, now);
					},
					l.name,
				);
				if (!composed || composed.deliveryId !== item.deliveryId) return undefined;
				if (!r.store.wakes.finish(composed.id, "dead_letter", now))
					throw new Error(`${spec.finishFail}: ${item.deliveryId}`);
				return composed;
			});
			if (!row) continue;
			ids.push(row.deliveryId);
			r.d.log(spec.log, {
				deliveryId: row.deliveryId,
				bytes: encodedSendBytes(row.message, row.deliveryId),
				maxBytes,
			});
		} catch {
			// Rolled back: held item remains; next pass retries. Never leave oversized pending.
		}
	}
	if (ids.length) {
		raise(r, l.akey(spec.alarmKey), spec.alarm(ids, maxBytes));
		for (const id of ids) r.reported.add(id);
	}
	return ids;
}

function oversizedHeldComposed(hit: HeldItem, now: number): Composed {
	const c = composeWake([hit], now);
	return {
		...c,
		...(hit.kind ? { kind: hit.kind } : {}),
		...(hit.thread ? { thread: hit.thread } : {}),
		...(hit.rights ? { rights: hit.rights } : {}),
	};
}

export function deadLetterOversizedTransfers(
	r: Ctx,
	l: Lane,
	now: number,
	maxBytes = TRANSFER_DIGEST_MAX_BYTES,
): string[] {
	return deadLetterOversizedSoloHolds({
		r,
		l,
		now,
		maxBytes,
		spec: {
			filter: isOversizedTransfer,
			compose: (hit, t) => ({
				...composeWake([hit], t),
				kind: "transfer" as const,
				...(hit.rights ? { rights: hit.rights } : {}),
			}),
			vanished: "oversized transfer vanished",
			finishFail: "oversized transfer finish failed",
			log: "transfer-oversized-dead-letter",
			alarmKey: "transfer-oversized",
			alarm: alarms.transferOversized,
		},
	});
}

export function deadLetterOversizedDigests(
	r: Ctx,
	l: Lane,
	now: number,
	maxBytes = TRANSFER_DIGEST_MAX_BYTES,
): string[] {
	return deadLetterOversizedSoloHolds({
		r,
		l,
		now,
		maxBytes,
		spec: {
			filter: isOversizedHeldDigest,
			compose: oversizedHeldComposed,
			vanished: "oversized held wake vanished",
			finishFail: "oversized held wake finish failed",
			log: "digest-oversized-dead-letter",
			alarmKey: "digest-oversized",
			alarm: alarms.digestOversized,
		},
	});
}
