/**
 * Commit and mirror a Steward switch. The SQLite transaction that inserts the new gen, opens the transfer,
 * enqueues the notice and sets phase=committed is the commit point.
 */
import { existsSync, statSync } from "node:fs";
import { setThread } from "./config-migrate.ts";
import { crashPoint } from "./crash.ts";
import { isPrivateSecret, secretPath } from "./layout.ts";
import { maxGen, switchRefName } from "./steward-gens.ts";
import type { StewardGen } from "./steward-types.ts";
import type { Store } from "./store.ts";

export type CommitResult = { ok: true; toGen: number } | { ok: false; code: 2 | 3; error: string };

function refOk(conf: string, name: string): boolean {
	const p = secretPath(conf, name);
	if (!p || !existsSync(p)) return false;
	try {
		return isPrivateSecret(p) || (statSync(p).mode & 0o777) === 0o600;
	} catch {
		return false;
	}
}

/** Resolve wake/compact refs for a switch (rollback copies the target gen's refs). */
function refsFor(
	store: Store,
	conf: string,
	id: string,
	noCompact: boolean,
): CommitResult | { wake: string; compact?: string } {
	const sw = store.steward.switchById(id);
	if (!sw) return { ok: false, code: 2, error: `no switch ${id}` };
	if (sw.rollbackOf !== undefined) {
		const g = store.steward.gen(sw.rollbackOf);
		if (!g) return { ok: false, code: 2, error: `rollback generation ${sw.rollbackOf} missing` };
		if (!refOk(conf, g.wakeRef))
			return { ok: false, code: 2, error: `wake ref missing for generation ${sw.rollbackOf}` };
		if (g.compactRef && !refOk(conf, g.compactRef))
			return { ok: false, code: 2, error: `compact ref missing for generation ${sw.rollbackOf}` };
		return { wake: g.wakeRef, ...(g.compactRef ? { compact: g.compactRef } : {}) };
	}
	const wake = switchRefName(id, "wake");
	if (!refOk(conf, wake)) return { ok: false, code: 2, error: `missing or non-private ${wake}` };
	if (noCompact) return { wake };
	const compact = switchRefName(id, "compact");
	if (!refOk(conf, compact)) return { ok: false, code: 2, error: `missing or non-private ${compact}` };
	return { wake, compact };
}

/** Commit a preparing switch. */
export function commitSwitch(
	store: Store,
	conf: string,
	o: { id: string; live: boolean; noCompact?: boolean; now?: number },
): CommitResult {
	if (!o.live) return { ok: false, code: 2, error: "steward switch requires --live" };
	const sw = store.steward.switchById(o.id);
	if (!sw) return { ok: false, code: 2, error: `no switch ${o.id}` };
	if (sw.phase !== "preparing") return { ok: false, code: 2, error: `switch ${o.id} is ${sw.phase}` };
	if (sw.fromGen !== maxGen(store))
		return { ok: false, code: 3, error: `from_gen ${sw.fromGen} is not current MAX(gen)=${maxGen(store)}` };
	const refs = refsFor(store, conf, o.id, o.noCompact === true);
	if ("ok" in refs) return refs;
	const now = o.now ?? Date.now();
	const toGen = sw.fromGen + 1;
	const noticeId = `switch-notice:${o.id}`;
	const gen: StewardGen = {
		gen: toGen,
		thread: sw.toThread,
		wakeRef: refs.wake,
		...(refs.compact ? { compactRef: refs.compact } : {}),
		createdAt: now,
	};
	try {
		store.tx(() => {
			crashPoint("switch-commit-begun");
			const again = store.steward.switchById(o.id);
			if (again?.phase !== "preparing" || again.fromGen !== store.steward.maxGen())
				throw new Error("CAS failed: switch no longer preparing at current gen");
			store.steward.insertGen(gen);
			// After the first write: a crash or throw here must roll the whole commit back (R5 atomicity).
			crashPoint("switch-commit-partial");
			store.steward.insertTransfer({
				fromGen: sw.fromGen,
				toGen,
				receiptHw: store.steward.maxReceiptId(),
				noticeId,
				openedAt: now,
			});
			store.wakes.enqueue({
				deliveryId: noticeId,
				message: `Steward switch committed: generation ${sw.fromGen} → ${toGen}. Thread ${sw.toThread}.`,
				queuedAt: now,
				kind: "switch_notice",
			});
			store.steward.setSwitchPhase(o.id, "committed", toGen);
		});
	} catch (e) {
		return { ok: false, code: 3, error: e instanceof Error ? e.message : String(e) };
	}
	crashPoint("switch-committed");
	return { ok: true, toGen };
}

/**
 * Mirror: under the config flock, write MAX(gen)'s thread into threads.steward, then set phase mirrored.
 * A late mirror converges on the current thread (H5).
 */
export function mirrorSwitch(store: Store, conf: string, id: string): CommitResult {
	const sw = store.steward.switchById(id);
	if (!sw) return { ok: false, code: 2, error: `no switch ${id}` };
	if (sw.phase !== "committed") return { ok: false, code: 2, error: `switch ${id} is ${sw.phase}` };
	const current = store.steward.current();
	if (!current) return { ok: false, code: 2, error: "no current generation" };
	setThread(conf, "steward", current.thread);
	store.tx(() => store.steward.setSwitchPhase(id, "mirrored"));
	return { ok: true, toGen: current.gen };
}

/** Finish mirrors for every committed switch (recovery). */
export function finishMirrors(store: Store, conf: string): number {
	let n = 0;
	for (const sw of store.steward.committedSwitches()) {
		const r = mirrorSwitch(store, conf, sw.id);
		if (r.ok) n++;
	}
	return n;
}
