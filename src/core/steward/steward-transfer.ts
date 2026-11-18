/**
 * Transfer pass: for each open transfer, create idempotent transfer items for unseen Steward deliveries,
 * hold them (kind=transfer, no thread → never folded), and compose in size-capped batches (V2-M1).
 * A single frozen payload that alone exceeds the encoded cap is never sent: it is dead-lettered with an alarm (R2).
 */
import { crashPoint } from "../crash.ts";
import { composeWake, memberHash } from "../decide/hold.ts";
import type { Store } from "../store/store.ts";
import type { HeldItem, RightsStamp } from "../store/store-wakes.ts";
import { isDischarged } from "./steward-discharge.ts";
import { transferMessage } from "./steward-header.ts";
import {
	exceedsEncodedCap,
	isSettledOrigin,
	type StewardTransfer,
	TRANSFER_DIGEST_MAX_BYTES,
	TRANSFER_DIGEST_MAX_ITEMS,
} from "./steward-types.ts";

export const transferItemId = (origId: number, fromGen: number) => `transfer:${origId}:g${fromGen}`;

/** Pointer-class stamp so transfer items wait on current decision rights. */
const pointerStamp = (): RightsStamp[] => [{ hash: "" }];

function rootIdOf(store: Store, rowId: number): { rootOutboxId: number; rootDeliveryId: string } {
	const row = store.wakes.rows("all").find((r) => r.id === rowId);
	const deliveryId = row?.deliveryId ?? String(rowId);
	// Preserve the original root across re-transfers so a descendant receipt closes ancestors (M1 / J2 / J3).
	const prior = row ? store.steward.transferItem(deliveryId) : undefined;
	if (prior) {
		const root = store.wakes.rows("all").find((r) => r.id === prior.rootOutboxId);
		return {
			rootOutboxId: prior.rootOutboxId,
			rootDeliveryId: root?.deliveryId ?? String(prior.rootOutboxId),
		};
	}
	return { rootOutboxId: rowId, rootDeliveryId: deliveryId };
}

/** Unseen delivered Steward rows ledgered at fromGen that need a transfer item. */
function transferSet(store: Store, fromGen: number): number[] {
	return store.wakes
		.rows("delivered", null)
		.filter((r) => {
			const led = store.steward.ledger(r.id);
			if (!led || led.gen !== fromGen || isSettledOrigin(led.origin)) return false;
			return !isDischarged(store, r.id);
		})
		.map((r) => r.id);
}

/** Create one transfer item + hold it, in one transaction. Idempotent. */
export function holdTransferItem(
	store: Store,
	o: { fromGen: number; origOutboxId: number; adoption?: boolean; fromThread?: string },
	now = Date.now(),
): string | undefined {
	const existing = store.steward.transferItemForOrig(o.fromGen, o.origOutboxId);
	if (existing) return existing.itemId;
	const orig = store.wakes.rows("all").find((r) => r.id === o.origOutboxId);
	if (!orig) return undefined;
	const { rootOutboxId, rootDeliveryId } = rootIdOf(store, o.origOutboxId);
	const itemId = transferItemId(o.origOutboxId, o.fromGen);
	const message = transferMessage(
		{
			rootId: rootDeliveryId,
			fromGen: o.fromGen,
			fromThread: o.fromThread,
			createdAt: orig.createdAt,
			adoption: o.adoption ?? o.fromGen === 0,
		},
		orig.message,
	);
	return store.tx(() => {
		store.steward.insertTransferItem({
			itemId,
			fromGen: o.fromGen,
			origOutboxId: o.origOutboxId,
			rootOutboxId,
		});
		crashPoint("transfer-item-held");
		if (!store.wakes.known(itemId)) {
			store.wakes.hold({
				deliveryId: itemId,
				message,
				queuedAt: now,
				kind: "transfer",
				rights: pointerStamp(),
			});
		}
		return itemId;
	});
}

/**
 * Compose held transfer items into one digest, capping count and UTF-8 encoded size of the
 * final send message (composeWake body + delivery-id trailer). An item that alone exceeds the
 * byte cap is never admitted (R2); callers dead-letter it. Overflow that would break the bound stays held.
 */
export function composeTransferBatch(
	held: HeldItem[],
	now: number,
	maxItems = TRANSFER_DIGEST_MAX_ITEMS,
	maxBytes = TRANSFER_DIGEST_MAX_BYTES,
): ReturnType<typeof composeWake> | undefined {
	const transfers = held.filter((h) => h.kind === "transfer").sort((a, b) => a.queuedAt - b.queuedAt);
	if (!transfers.length) return undefined;
	const batch: HeldItem[] = [];
	for (const item of transfers) {
		const next = [...batch, item];
		const trial = composeWake(next, now);
		if (exceedsEncodedCap(trial.message, trial.deliveryId, maxBytes) || next.length > maxItems) {
			if (batch.length === 0) continue; // refuse oversized solo — never send
			break;
		}
		batch.push(item);
	}
	return batch.length ? composeWake(batch, now) : undefined;
}

export { deadLetterOversizedDigests, deadLetterOversizedTransfers } from "./steward-oversized-dead-letter.ts";

/** Seal when MAX(gen) ≠ F and no pending row has attempt_gen = F. */
function trySeal(store: Store, t: StewardTransfer, now = Date.now()): boolean {
	if (t.sealedAt !== undefined) return true;
	if (store.steward.maxGen() === t.fromGen) return false;
	if (store.steward.pendingWithAttemptGen(t.fromGen).length) return false;
	store.tx(() => store.steward.sealTransfer(t.fromGen, now));
	return true;
}

/** Close when sealed and every root in the set is discharged. */
function tryClose(store: Store, t: StewardTransfer, now = Date.now()): boolean {
	if (t.closedAt !== undefined) return true;
	const sealed = trySeal(store, t, now);
	if (!sealed) return false;
	const items = store.steward.itemsOfTransfer(t.fromGen);
	const roots = new Set(items.map((i) => i.rootOutboxId));
	for (const id of transferSet(store, t.fromGen)) roots.add(id);
	for (const root of roots) {
		if (!isDischarged(store, root)) return false;
	}
	store.tx(() => store.steward.closeTransfer(t.fromGen, now));
	return true;
}

function holdMissingItems(store: Store, t: StewardTransfer, now: number): number {
	const fromThread = t.fromGen >= 1 ? store.steward.gen(t.fromGen)?.thread : undefined;
	let n = 0;
	for (const origId of transferSet(store, t.fromGen)) {
		const id = holdTransferItem(
			store,
			{
				fromGen: t.fromGen,
				origOutboxId: origId,
				adoption: t.fromGen === 0,
				...(fromThread ? { fromThread } : {}),
			},
			now,
		);
		if (id) n++;
	}
	return n;
}

/** Whether a held or composed transfer item replays a root that is discharged now. */
function replaysDischarged(store: Store, deliveryId: string): boolean {
	const item = store.steward.transferItem(deliveryId);
	return item !== undefined && isDischarged(store, item.rootOutboxId);
}

/**
 * Transfer items whose root is discharged now (its receipt was found after the item was made) are given up, so a wake the retired Steward
 * handled before the switch is never replayed to the new one:
 * - held items are composed into one row and cancelled in a single transaction, so each keeps a permanent tombstone;
 * - a composed transfer row not yet attempted, every member of which replays a discharged root, is cancelled. The relay attempts only a
 *   pending row, so a cancel that lands first means no POST; one that loses the race to an attempt already begun changes nothing.
 */
function dropDischargedTransfers(store: Store, now = Date.now()): string[] {
	const gone = store.wakes
		.held(null)
		.filter((h) => h.kind === "transfer" && replaysDischarged(store, h.deliveryId))
		.map((h) => h.deliveryId);
	const rows = store.wakes
		.rows("pending", null)
		.filter((r) => r.attempts === 0 && r.members.length > 0)
		.filter((r) => r.members.every((m) => m.kind === "transfer" && replaysDischarged(store, m.deliveryId)));
	if (!gone.length && !rows.length) return [];
	store.tx(() => {
		for (const r of rows) store.wakes.cancel(r.deliveryId, now);
		if (!gone.length) return;
		const row = store.wakes.compose(
			now,
			() => ({
				deliveryId: `transfer-discharged:${memberHash(gone)}`,
				message: `Transfer items given up: the retired Steward handled their wakes before the switch (${gone.join(", ")}).`,
				folded: 0,
				members: gone,
				kind: "transfer",
			}),
			null,
		);
		if (row) store.wakes.cancel(row.deliveryId, now);
	});
	return [...gone, ...rows.flatMap((r) => r.members.map((m) => m.deliveryId))];
}

/** One transfer pass: drop held items already discharged, create missing items for every open transfer, then try seal/close. */
export function transferPass(
	store: Store,
	now = Date.now(),
): { held: number; sealed: number; closed: number; dropped: number } {
	const dropped = dropDischargedTransfers(store, now).length;
	let held = 0;
	let sealed = 0;
	let closed = 0;
	for (const t of store.steward.openTransfers()) {
		held += holdMissingItems(store, t, now);
		const fresh = store.steward.transfer(t.fromGen);
		if (fresh && trySeal(store, fresh, now)) sealed++;
		const after = store.steward.transfer(t.fromGen);
		if (after && tryClose(store, after, now)) closed++;
	}
	return { held, sealed, closed, dropped };
}
