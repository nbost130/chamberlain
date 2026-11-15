/**
 * Daemon recovery (§2.7): after takeRelayLock and startup(), before modules/engine:
 * seed, clear attempt_gen, adopt, finish mirrors, evidence + transfer, log steward-recovered.
 */
import type { Log } from "./log.ts";
import { type AdoptFindReceipt, adoptPass } from "./steward-adopt.ts";
import { finishMirrors } from "./steward-commit.ts";
import { type EvidenceFinder, evidencePass } from "./steward-evidence.ts";
import { seedGen1 } from "./steward-gens.ts";
import { checkSwitchNotice } from "./steward-notice.ts";
import { transferPass } from "./steward-transfer.ts";
import type { Store } from "./store.ts";

export type RecoverDeps = {
	store: Store;
	conf: string;
	log: Log;
	findReceipt: AdoptFindReceipt & EvidenceFinder;
	now?: number;
	alarm?: (key: string, title: string, summary: string) => void;
};

export type RecoverCounts = {
	seeded: boolean;
	adopted: number;
	unrecoverable: number;
	receipts: number;
	transfersHeld: number;
	mirrors: number;
};

/** One recovery pass. Safe to re-run (adoption and transfer are idempotent). */
export function recoverSteward(d: RecoverDeps): RecoverCounts {
	const now = d.now ?? Date.now();
	const seeded = seedGen1(d.store, d.conf, now) !== undefined && d.store.steward.maxGen() >= 1;
	d.store.tx(() => d.store.steward.clearAllAttemptGens());
	const adopt = adoptPass(d.store, d.findReceipt, now);
	const mirrors = finishMirrors(d.store, d.conf);
	const receipts = evidencePass(d.store, d.findReceipt, { now });
	const xfer = transferPass(d.store, now);
	if (d.alarm) checkSwitchNotice(d.store, d.alarm, now);
	const counts: RecoverCounts = {
		seeded,
		adopted: adopt.adopted,
		unrecoverable: adopt.unrecoverable,
		receipts: receipts + adopt.receipted,
		transfersHeld: xfer.held + adopt.transferItems,
		mirrors,
	};
	d.log("steward-recovered", { ...counts });
	if (adopt.unrecoverable) d.log("steward-adopted", { unrecoverable: adopt.unrecoverable, adopted: adopt.adopted });
	return counts;
}
