/** Read-only `steward status [--id]`: unresolved Steward work. */

import { isDischarged } from "./steward-discharge.ts";
import { currentGen, maxGen } from "./steward-gens.ts";
import type { Store } from "./store.ts";

export type StatusLine = string;

/** Human-readable status of generations, open transfers and undischarged rows. */
export function stewardStatus(store: Store, id?: string): StatusLine[] {
	if (id) return statusForId(store, id);
	const lines: StatusLine[] = [];
	const cur = currentGen(store);
	lines.push(`current generation: ${maxGen(store)}${cur ? ` thread=${cur.thread}` : ""}`);
	const open = store.steward.openSwitch();
	if (open) lines.push(`open switch: ${open.id} phase=${open.phase} → ${open.toThread}`);
	for (const t of store.steward.openTransfers()) {
		lines.push(
			`transfer g${t.fromGen}→g${t.toGen} notice=${t.noticeId} sealed=${t.sealedAt ?? "-"} closed=${t.closedAt ?? "-"}`,
		);
	}
	const undischarged = store.wakes.rows("delivered", null).filter((r) => {
		const led = store.steward.ledger(r.id);
		if (!led || led.origin === "unrecoverable") return false;
		const hw = store.steward.transfer(led.gen)?.receiptHw;
		return !isDischarged(store, r.id, hw);
	});
	lines.push(`undischarged Steward deliveries: ${undischarged.length}`);
	for (const r of undischarged.slice(0, 20)) {
		const led = store.steward.ledger(r.id);
		const ageH = Math.round((Date.now() - (r.finishedAt ?? r.createdAt)) / 3600_000);
		lines.push(`  ${r.deliveryId} gen=${led?.gen} origin=${led?.origin} age=${ageH}h`);
	}
	return lines;
}

function statusForId(store: Store, id: string): StatusLine[] {
	const row = store.wakes.find(id);
	if (!row) return [`no outbox row for ${id}`];
	const item = store.steward.transferItem(id);
	const led = store.steward.ledger(row.id);
	const lines = [
		`${id}: status=${row.status} kind=${row.kind ?? "-"} gen=${led?.gen ?? "-"} origin=${led?.origin ?? "-"}`,
	];
	if (item) lines.push(`  transfer item from_gen=${item.fromGen} orig=${item.origOutboxId} root=${item.rootOutboxId}`);
	const receipt = store.steward.receiptFor(row.id);
	if (receipt) lines.push(`  receipt kind=${receipt.kind} id=${receipt.id}`);
	else lines.push("  no receipt (undischarged unless a descendant holds one)");
	return lines;
}
