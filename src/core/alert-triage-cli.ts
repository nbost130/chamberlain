/** `chamberlain triage ack|resolve|status|list`. Pure over a Store for tests. */
import { encodeAlertData } from "./alert-data.ts";
import { ALERT_TRIAGE } from "./alert-triage-config.ts";
import { OCC_RE } from "./alert-triage-ids.ts";
import { findByOcc, listObligations } from "./alert-triage-obligation.ts";
import { defaultStore } from "./default-store.ts";
import type { Store } from "./store.ts";

type Out = (line: string) => void;

function requireOcc(ref: string | undefined, err: Out): string | undefined {
	if (!ref || !OCC_RE.test(ref)) {
		err(`triage: ref must match ^ao_[0-9a-f]{20}$ (got ${JSON.stringify(ref)})`);
		return undefined;
	}
	return ref;
}

export function runTriage(store: Store, argv: string[], out: Out = console.log, err: Out = console.error): number {
	const [cmd, ...rest] = argv;
	if (cmd === "ack" || cmd === "resolve" || cmd === "status") {
		const ref = requireOcc(rest[0], err);
		if (!ref) return 2;
		if (cmd === "ack") return ack(store, ref, out);
		if (cmd === "resolve") return resolve(store, ref, out);
		return status(store, ref, out);
	}
	if (cmd === "list") {
		list(store, rest.includes("--all"), out);
		return 0;
	}
	err("triage: usage: triage ack|resolve|status <ao_ref> | triage list [--all]");
	return 2;
}

function ack(store: Store, ref: string, out: Out): number {
	const found = findByOcc(store, ref, true);
	if (!found) {
		out(`triage ack: no obligation ${ref}`);
		return 0;
	}
	if (found.ob.state === "acked" || store.items.get(ALERT_TRIAGE, found.key)?.status === "resolved") return 0;
	store.tx(() => {
		store.items.patch(ALERT_TRIAGE, found.key, { state: "acked", ackedAt: Date.now(), slot: false });
	});
	out(`triage ack: ${ref}`);
	return 0;
}

function resolve(store: Store, ref: string, out: Out): number {
	const found = findByOcc(store, ref, true);
	if (!found) {
		out(`triage resolve: no obligation ${ref}`);
		return 0;
	}
	store.tx(() => {
		store.items.patch(ALERT_TRIAGE, found.key, { slot: false });
		store.items.resolve(ALERT_TRIAGE, found.key);
	});
	out(`triage resolve: ${ref}`);
	return 0;
}

function status(store: Store, ref: string, out: Out): number {
	const found = findByOcc(store, ref, true);
	if (!found) {
		out(`triage status: no obligation ${ref}`);
		return 0;
	}
	out(
		`ref ${found.ob.occ} state ${found.ob.state} rule ${found.ob.rule} ordinal ${found.ob.ordinal} folded ${found.ob.folded}`,
	);
	out(encodeAlertData(found.ob.event));
	return 0;
}

function list(store: Store, all: boolean, out: Out): void {
	const obs = listObligations(store, all);
	for (const ob of obs) {
		out(`${ob.occ} ${ob.state} rule=${ob.rule} folded=${ob.folded}`);
		out(encodeAlertData(ob.event));
	}
	if (!obs.length) out("triage list: none");
}

export function main(argv: string[]): number {
	return runTriage(defaultStore(), argv);
}
