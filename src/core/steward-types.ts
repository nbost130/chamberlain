/**
 * Types for the Steward switch protocol (migration 15): generations, switches, receipts, transfers and adoption.
 * Gen 0 means "legacy, destination unknown" and has no steward_gens row; never present it as a known previous Steward.
 */

import { finalSendMessage } from "./deliver.ts";

export type StewardOrigin = "live" | "adopted" | "unrecoverable" | "adopted-historical";

/** Origins that are settled without a receipt or transfer (retention/status/evidence skip them). */
export const isSettledOrigin = (origin: StewardOrigin): boolean =>
	origin === "unrecoverable" || origin === "adopted-historical";

/** State key: max pre-v2 Steward delivered outbox id (migration 16). Rows at or below are historical. */
export const HISTORICAL_ADOPT_HI_KEY = "steward.adopt.historical_hi";
export type SwitchPhase = "preparing" | "committed" | "mirrored" | "aborted";
export type ReceiptKind = "t3-run" | "operator";

export type StewardGen = {
	gen: number;
	thread: string;
	wakeRef: string;
	compactRef?: string;
	createdAt: number;
};

export type StewardSwitch = {
	id: string;
	fromGen: number;
	toThread: string;
	rollbackOf?: number;
	phase: SwitchPhase;
	preparedAt: number;
	toGen?: number;
};

export type StewardDelivery = {
	outboxId: number;
	gen: number;
	origin: StewardOrigin;
};

export type StewardReceipt = {
	id: number;
	outboxId: number;
	kind: ReceiptKind;
	runId?: string;
	thread?: string;
	recordedAt: number;
};

export type StewardTransfer = {
	fromGen: number;
	toGen: number;
	receiptHw: number;
	noticeId: string;
	openedAt: number;
	sealedAt?: number;
	closedAt?: number;
};

export type TransferItem = {
	itemId: string;
	fromGen: number;
	origOutboxId: number;
	rootOutboxId: number;
};

/** A T3 run that proves a delivery was input to a completed turn (seen-proof). */
export type ReceiptHit = {
	outboxId: number;
	runId: string;
	thread: string;
	recordedAt: number;
};

/** Caps for one transfer/adoption replay digest (V2-M1): overflow stays held and is paced by the gate. */
export const TRANSFER_DIGEST_MAX_ITEMS = 5;
export const TRANSFER_DIGEST_MAX_BYTES = 24_000;

/**
 * True when the final encoded send message (body + delivery-id trailer) exceeds the replay bound.
 * Always measure via finalSendMessage — the transport POSTs that framing, not the stored body alone.
 */
export const exceedsEncodedCap = (message: string, deliveryId: string, maxBytes = TRANSFER_DIGEST_MAX_BYTES): boolean =>
	Buffer.byteLength(finalSendMessage(message, deliveryId), "utf8") > maxBytes;

/** UTF-8 size of the final send message (framing included). */
export const encodedSendBytes = (message: string, deliveryId: string): number =>
	Buffer.byteLength(finalSendMessage(message, deliveryId), "utf8");

/** How long after the current switch notice is delivered with no counting receipt before the unacknowledged alarm (G1/G2). */
export const SWITCH_NOTICE_STALL_MS = 20 * 60_000;
