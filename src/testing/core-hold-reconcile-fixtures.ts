import { appendHeld, HELD, type Held, heldOpen } from "../core/afk-held.ts";
import type { GhRead } from "../core/hold-lookup.ts";
import { reconcileRefHolds } from "../core/hold-reconcile.ts";
import type { MachineSnapshot, ThreadFacts } from "../core/hold-threads.ts";
import type { Answer, Question } from "../core/questions.ts";
import type { Store } from "../core/store.ts";

const T0 = new Date("2026-11-13T01:00:00.000Z");

export const question = (id: string): Question => ({
	id,
	kind: "only-you",
	title: id,
	context: "",
	options: [{ label: "Yes" }],
	thread: "T",
	server: "main",
	createdAt: "2026-11-13T00:00:00.000Z",
});

export const answerOf = (id: string, by: "page" | "batch", t = "2026-11-13T02:00:00.000Z"): Answer => ({
	choice: 0,
	label: "Yes",
	by,
	t,
	deliveryId: `answer:item:${id}`,
});

export const hold = (store: Store, h: Partial<Held> & { thread: string }, at = T0) =>
	appendHeld(store, { what: "waits", ...h }, at);

export const whats = (store: Store) =>
	heldOpen(store)
		.map((h) => h.thread)
		.sort();

export const how = (store: Store, id: string) => String(store.items.get(HELD, id)?.payload.how);

export const NOW = Date.parse("2026-11-13T13:00:00.000Z");

/** A fake GitHub keyed by API path. A missing path rejects, as a real API error does. */
export function fakeGh(table: Record<string, unknown | Error>) {
	const calls: string[] = [];
	const gh: GhRead = async (path) => {
		calls.push(path);
		const v = table[path];
		if (v === undefined) throw Error("GitHub read failed: HTTP 502");
		if (v instanceof Error) throw v;
		return v;
	};
	return { gh, calls };
}

type Snaps = (() => Promise<MachineSnapshot[]>) | undefined;

export const run = (store: Store, gh?: GhRead, snapshots: Snaps = undefined, now = NOW) =>
	reconcileRefHolds({ store, now, ...(gh ? { gh } : {}), ...(snapshots ? { snapshots } : {}) });

export const facts = (over: Partial<ThreadFacts> = {}): ThreadFacts => ({
	archived: false,
	settled: false,
	pendingRequestId: null,
	status: "idle",
	...over,
});

/** A server's snapshot taken this pass. */
export const machine = (
	name: string,
	table: Record<string, ThreadFacts>,
	o: { healthy?: boolean; complete?: boolean } = {},
): MachineSnapshot => ({
	machine: name,
	healthy: o.healthy ?? true,
	complete: o.complete ?? true,
	get: (id) => table[id],
});

export const PR = "repos/example-org/app/pulls/962";
