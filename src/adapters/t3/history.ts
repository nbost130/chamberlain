/**
 * T3's history: a thread's latest instruction, wherever it sits. T3 returns only a thread's newest items: 75, or 10 user
 * turns, or 1MB. One long turn pushes the instruction out of that window, and a reader that looks only there sees a
 * thread nobody instructed. The bounded snapshot gives the same window plus a cursor into T3's history pages, which reach the rest.
 */
import { LIVE, lastInstruction, type TurnItem } from "../../core/decide.ts";
import type { InstructionRead } from "../../core/history.ts";

/** A page holds at most 75 items, and the conversation view leaves out tool noise, so this reaches thousands of messages back. */
export const HISTORY_PAGES_MAX = 40;
const READ_TIMEOUT_MS = 15_000;

export type HistoryGet = (path: string) => Promise<unknown>;

type Run = { id?: string; ordinal?: number; status?: string };
type Projection = { turnItems?: TurnItem[]; runs?: Run[] };
type Bounded = { projection?: Projection; historyCursor?: string | null; hasMoreHistory?: boolean };
type Row = { visibility?: string; sourceThreadId?: string; item?: TurnItem };
type Page = { items?: Row[]; nextCursor?: string | null; hasMoreHistory?: boolean };

/** Reads over HTTP: T3's history pages have no RPC, and the projection RPC gives no cursor. */
export const historyGet = (origin: string, readToken: () => string | undefined): HistoryGet => async (path) => {
	const token = readToken();
	if (!token) throw Error("no token");
	const r = await fetch(new URL(path, origin), {
		headers: { Authorization: `Bearer ${token}`, "x-t3-orchestration-protocol": "2" },
		signal: AbortSignal.timeout(READ_TIMEOUT_MS),
	});
	if (!r.ok) throw Error(`${path.split("?")[0]} returned HTTP ${r.status}`);
	return r.json();
};

/** The run that last ended. A newer run may already be queued or running, and it isn't the turn being asked about. */
const lastEnded = (runs: Run[] = []) => runs.filter((r) => !LIVE.has(String(r.status))).reduce<Run | undefined>((a, r) => (!a || (r.ordinal ?? -1) > (a.ordinal ?? -1) ? r : a), undefined);
/** A retained interrupt request sits at the end of T3's window whatever its age, so it says nothing about where a run began. */
const runItems = (items: TurnItem[], runId: string) => items.findIndex((i) => i.runId === runId && i.type !== "run_interrupt_request");
/** The run's first item is in hand once an item before it belongs to something else. */
const haveRunStart = (items: TurnItem[], runId: string | undefined) => !runId || runItems(items, runId) > 0;
/**
 * T3's rule: a notification that is its run's first input started that run for a machine (a background task finishing,
 * a Monitor's output, a PR update). So does a machine delivery, which instructs nobody. An instruction steered in later
 * doesn't change who started it. Unknown is not a machine's, so a run that can't be classified counts as every run used to.
 */
function startedByMachine(items: TurnItem[], runId: string | undefined): boolean {
	const first = runId ? items[runItems(items, runId)] : undefined;
	return first?.type === "notification" || (first?.type === "user_message" && first.creationSource === "server");
}

/** Never throws. A forked thread's pages also carry its parent's rows, and those instructed the parent. */
export async function readInstruction(threadId: string, get: HistoryGet): Promise<InstructionRead> {
	const base = `/api/orchestration/threads/${encodeURIComponent(threadId)}`;
	try {
		const bounded = (await get(`${base}/bounded`)) as Bounded;
		if (!Array.isArray(bounded.projection?.turnItems)) throw Error("bounded snapshot had no turnItems");
		let items = bounded.projection.turnItems;
		const runId = lastEnded(bounded.projection.runs)?.id;
		let more = bounded.hasMoreHistory === true;
		let cursor = bounded.historyCursor;
		for (let pages = 0; more && !(lastInstruction(items) && haveRunStart(items, runId)); pages++) {
			if (!cursor || pages === HISTORY_PAGES_MAX) return { items, state: "truncated", byMachine: false };
			const page = (await get(`${base}/history?cursor=${encodeURIComponent(cursor)}&view=conversation`)) as Page;
			if (!Array.isArray(page.items)) throw Error("history page had no items");
			const local = page.items.filter((r) => r.visibility === "local" || r.sourceThreadId === threadId).flatMap((r) => (r.item ? [r.item] : []));
			items = [...local, ...items];
			more = page.hasMoreHistory === true;
			cursor = page.nextCursor;
		}
		return { items, state: "complete", byMachine: startedByMachine(items, runId) };
	} catch (e) {
		return { items: [], state: "failed", error: String(e).slice(0, 200), byMachine: false };
	}
}

/** HTTP can work while a watcher's socket is down, and then its state is stale, so no socket is a failed read. */
export const readWhenConnected = async (connected: boolean, threadId: string, get: HistoryGet): Promise<InstructionRead> =>
	connected ? readInstruction(threadId, get) : { items: [], state: "failed", error: "not connected", byMachine: false };
