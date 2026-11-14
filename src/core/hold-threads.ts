/** What a fresh snapshot of each server says of a thread: settled, gone, live or not known (the thread refs of ./hold-reconcile.ts). */

/** What a snapshot says of a thread: settled with nothing pending, archived or deleted, still live, or not known. */
export type ThreadView = { state: "settled" | "gone"; saw: string } | { state: "live" } | { state: "unknown" };
/** What a snapshot knows of one thread. */
export type ThreadFacts = { archived: boolean; settled: boolean; pendingRequestId: string | null; status: string };
/** Pure: a listed thread is gone when archived, settled when settled with no card or approval pending, and otherwise live. */
export const classifyThread = (t: ThreadFacts): ThreadView =>
	t.archived
		? { state: "gone", saw: "archived" }
		: t.settled && !t.pendingRequestId && t.status !== "waiting"
			? { state: "settled", saw: "settled" }
			: { state: "live" };
/**
 * One server's thread list, fetched in THIS pass over a connection of its own (`Adapter.snapshot`), never the cache the
 * watcher keeps. `healthy`: the server answered. `complete`: the answer was the whole list. A server that is offline,
 * unreachable, partial, or whose adapter cannot take a snapshot is not healthy and complete, and says nothing about any thread.
 */
export type MachineSnapshot = {
	machine: string;
	healthy: boolean;
	complete: boolean /** Some record in it could not be read: it says nothing of a thread it lacks. */;
	partial?: boolean;
	get: (id: string) => ThreadFacts | undefined;
};
/**
 * Pure: a thread's state. Only a snapshot that is fresh, healthy and complete counts, and the thread's own server decides.
 *   - The hold names its server (`server`): only that server's snapshot is read. Listed there: settled, archived or live
 *     as it says. Missing from it: gone, unless the snapshot has an unreadable record (`partial`), which could be this thread:
 *     then unknown. That server's snapshot absent, unhealthy or incomplete: unknown. Any other server's says nothing about it.
 *   - The server is not named: a thread listed by exactly one good snapshot is read from it (the listing names its server),
 *     and only when no snapshot that answered is partial or has an unreadable record: either could hold a second listing of
 *     the thread, so "listed by exactly one" cannot be trusted and it is unknown. Listed by none, or by two, it is unknown. It is NEVER gone: with no server named, absence proves nothing.
 * Nothing else (a cache, a stream's last word) ever settles or removes a thread.
 */
export function threadViewAcross(snaps: MachineSnapshot[], id: string, server?: string): ThreadView {
	const good = snaps.filter((s) => s.healthy && s.complete);
	if (server !== undefined) {
		const own = good.find((s) => s.machine === server);
		if (!own) return { state: "unknown" };
		const t = own.get(id);
		if (t) return classifyThread(t);
		return own.partial ? { state: "unknown" } : { state: "gone", saw: `gone from ${server}'s fresh snapshot` };
	}
	// A snapshot that answered but is not whole, or has an unreadable record, could hold a second listing of this thread.
	if (snaps.some((s) => s.healthy && (!s.complete || s.partial))) return { state: "unknown" };
	const listed = good.flatMap((s) => {
		const t = s.get(id);
		return t ? [t] : [];
	});
	const [only] = listed;
	return listed.length === 1 && only ? classifyThread(only) : { state: "unknown" };
}
/**
 * Fresh snapshots, one per server, each fetched now. A server whose fetch fails is reported unhealthy and says nothing; one
 * whose answer is marked partial is not complete; one with a record that cannot be read is `partial`. Never throws.
 */
/** Pure: a snapshot record in the shape `ThreadFacts & { id }` asks for. */
function isThreadRecord(t: unknown): t is ThreadFacts & { id: string } {
	if (!t || typeof t !== "object") return false;
	const o = t as Record<string, unknown>;
	return (
		typeof o.id === "string" &&
		o.id !== "" &&
		typeof o.archived === "boolean" &&
		typeof o.settled === "boolean" &&
		(o.pendingRequestId === null || (typeof o.pendingRequestId === "string" && o.pendingRequestId !== "")) &&
		typeof o.status === "string"
	);
}
export async function takeSnapshots(
	machines: { name: string; fetch: () => Promise<{ complete: boolean; threads: (ThreadFacts & { id: string })[] }> }[],
): Promise<MachineSnapshot[]> {
	return Promise.all(
		machines.map(async (m): Promise<MachineSnapshot> => {
			try {
				const r = await m.fetch();
				if (!r.complete || !Array.isArray(r.threads))
					return { machine: m.name, healthy: true, complete: false, get: () => undefined };
				// A record that cannot be read is left out and marks the snapshot partial: it could be any thread.
				const readable = r.threads.filter(isThreadRecord);
				const table = new Map<string, ThreadFacts>(readable.map((t) => [t.id, t]));
				return {
					machine: m.name,
					healthy: true,
					complete: true,
					...(readable.length !== r.threads.length ? { partial: true } : {}),
					get: (id) => table.get(id),
				};
			} catch {
				return { machine: m.name, healthy: false, complete: false, get: () => undefined };
			}
		}),
	);
}
