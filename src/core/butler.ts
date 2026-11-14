/**
 * The butler ledger: which narrow-scope helper threads the Steward has started and which are still live. One row per
 * butler in the database's `butlers` table: started when it is added, live until it is stopped.
 *
 *   bun src/core/butler.ts start --thread <threadId> --machine <name> --model <model> --scope "<one sentence>" [--id <id>]
 *   bun src/core/butler.ts stop <id> [--reason "<why>"]
 *   bun src/core/butler.ts list [--all]
 */
import { randomBytes } from "node:crypto";
import { defaultStore } from "./default-store.ts";
import { startup } from "./migrate.ts";
import type { Store } from "./store.ts";

export type Butler = {
	id: string;
	thread: string;
	machine: string;
	model: string;
	scope: string;
	started: string;
	stopped?: string;
	reason?: string;
};

/** Every butler ever started, with its stop folded in, in the order they started. */
export const readButlers = (store: Store): Butler[] => store.butlers.list();
export const liveButlers = (store: Store) => readButlers(store).filter((b) => !b.stopped);

/** Records a new butler. Every field is required, and an ID already in the ledger is refused. Returns the row written. */
export function startButler(
	store: Store,
	f: { thread: string; machine: string; model: string; scope: string; id?: string },
	now = new Date(),
): Butler {
	for (const k of ["thread", "machine", "model", "scope"] as const)
		if (!f[k]?.trim()) throw Error(`butler start: --${k} is required`);
	const id = f.id?.trim() || `B-${randomBytes(3).toString("hex")}`;
	const b: Butler = {
		id,
		thread: f.thread.trim(),
		machine: f.machine.trim(),
		model: f.model.trim(),
		scope: f.scope.trim(),
		started: now.toISOString(),
	};
	if (!store.butlers.insert(b)) throw Error(`butler start: ${id} is already in the ledger`);
	return b;
}

/** Marks a butler stopped. An unknown ID is refused; one already stopped is left as it was and reported. */
export function stopButler(
	store: Store,
	id: string,
	reason?: string,
	now = new Date(),
): { butler: Butler; already: boolean } {
	return store.tx(() => {
		const b = store.butlers.get(id);
		if (!b) throw Error(`butler stop: no butler ${id} in the ledger`);
		if (b.stopped) return { butler: b, already: true };
		store.butlers.stop(id, now.toISOString(), reason);
		return { butler: { ...b, stopped: now.toISOString(), ...(reason ? { reason } : {}) }, already: false };
	});
}

export function formatButlers(list: Butler[], now = Date.now()): string {
	if (!list.length) return "no butlers";
	return list
		.map(
			(b) =>
				`${b.id}\t${b.stopped ? `stopped ${b.stopped}${b.reason ? ` (${b.reason})` : ""}` : `live ${Math.round((now - Date.parse(b.started)) / 60_000)}m`}\t${b.machine}\t${b.model}\tthread ${b.thread}\t${b.scope}`,
		)
		.join("\n");
}

const arg = (argv: string[], name: string) => {
	const i = argv.indexOf(name);
	return i >= 0 ? argv[i + 1] : undefined;
};

export function main(argv: string[] = process.argv.slice(2)) {
	startup();
	const store = defaultStore();
	const [cmd, ...rest] = argv;
	try {
		if (cmd === "start") {
			const b = startButler(store, {
				thread: arg(rest, "--thread") ?? "",
				machine: arg(rest, "--machine") ?? "",
				model: arg(rest, "--model") ?? "",
				scope: arg(rest, "--scope") ?? "",
				id: arg(rest, "--id"),
			});
			console.log(b.id);
		} else if (cmd === "stop") {
			if (!rest[0]) throw Error("usage: butler.ts stop <id> [--reason <why>]");
			const r = stopButler(store, rest[0], arg(rest, "--reason"));
			console.log(r.already ? `${r.butler.id} was already stopped at ${r.butler.stopped}` : `${r.butler.id} stopped`);
		} else if (cmd === "list") {
			console.log(formatButlers(rest.includes("--all") ? readButlers(store) : liveButlers(store)));
		} else {
			console.error(
				'usage: butler.ts start --thread <id> --machine <name> --model <model> --scope "<text>" [--id <id>] | stop <id> [--reason <why>] | list [--all]',
			);
			process.exit(2);
		}
	} catch (e) {
		console.error((e as Error).message);
		process.exit(1);
	}
}

if (import.meta.main) main();
