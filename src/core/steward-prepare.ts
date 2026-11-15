/**
 * `steward prepare`: insert a preparing switch and print switch-owned secret paths (never URLs).
 * Requires --live. Unique index refuses a second open switch.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { secretPath } from "./layout.ts";
import { ensureStewardSecretsDir, maxGen, switchRefPath } from "./steward-gens.ts";
import type { StewardSwitch } from "./steward-types.ts";
import type { Store } from "./store.ts";

export type PrepareResult =
	| { ok: true; id: string; wakePath: string; compactPath: string; rollback?: true }
	| { ok: false; code: 2 | 3; error: string };

const newSwitchId = (): string => randomBytes(8).toString("hex");

/** Prepare a forward switch to `toThread`. */
export function prepareSwitch(
	store: Store,
	conf: string,
	o: { toThread: string; live: boolean; now?: number },
): PrepareResult {
	if (!o.live) return { ok: false, code: 2, error: "steward prepare requires --live" };
	if (store.steward.openSwitch())
		return { ok: false, code: 3, error: "a switch is already preparing; abort it or commit it first" };
	const fromGen = maxGen(store);
	if (fromGen < 1) return { ok: false, code: 2, error: "no steward generation is seeded yet" };
	const id = newSwitchId();
	ensureStewardSecretsDir(conf);
	const sw: StewardSwitch = {
		id,
		fromGen,
		toThread: o.toThread,
		phase: "preparing",
		preparedAt: o.now ?? Date.now(),
	};
	try {
		store.tx(() => store.steward.insertSwitch(sw));
	} catch (e) {
		return { ok: false, code: 3, error: e instanceof Error ? e.message : String(e) };
	}
	return { ok: true, id, wakePath: switchRefPath(conf, id, "wake"), compactPath: switchRefPath(conf, id, "compact") };
}

/** Prepare a rollback to an earlier generation's thread and refs (no new files). */
export function prepareRollback(
	store: Store,
	conf: string,
	o: { toGen: number; live: boolean; now?: number },
): PrepareResult {
	if (!o.live) return { ok: false, code: 2, error: "steward prepare requires --live" };
	if (store.steward.openSwitch())
		return { ok: false, code: 3, error: "a switch is already preparing; abort it or commit it first" };
	const target = store.steward.gen(o.toGen);
	if (!target) return { ok: false, code: 2, error: `generation ${o.toGen} does not exist` };
	const wakeFile = secretPath(conf, target.wakeRef);
	if (!wakeFile || !existsSync(wakeFile))
		return { ok: false, code: 2, error: `rollback refused: wake ref missing for generation ${o.toGen}` };
	if (target.compactRef) {
		const c = secretPath(conf, target.compactRef);
		if (!c || !existsSync(c))
			return { ok: false, code: 2, error: `rollback refused: compact ref missing for generation ${o.toGen}` };
	}
	const id = newSwitchId();
	const sw: StewardSwitch = {
		id,
		fromGen: maxGen(store),
		toThread: target.thread,
		rollbackOf: o.toGen,
		phase: "preparing",
		preparedAt: o.now ?? Date.now(),
	};
	store.tx(() => store.steward.insertSwitch(sw));
	return {
		ok: true,
		id,
		wakePath: wakeFile,
		compactPath: target.compactRef ? (secretPath(conf, target.compactRef) ?? "") : "",
		rollback: true,
	};
}

/** Abort a preparing switch; deletes nothing. */
export function abortSwitch(store: Store, id: string): { ok: true } | { ok: false; code: 2; error: string } {
	const sw = store.steward.switchById(id);
	if (!sw) return { ok: false, code: 2, error: `no switch ${id}` };
	if (sw.phase !== "preparing") return { ok: false, code: 2, error: `switch ${id} is ${sw.phase}, not preparing` };
	store.tx(() => store.steward.setSwitchPhase(id, "aborted"));
	return { ok: true };
}
