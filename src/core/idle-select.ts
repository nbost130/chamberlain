/**
 * THE idle-thread selection of the `idle-parents` check (./idle-parents.ts): which threads finished their work and sat idle past a
 * threshold, as plain records. Plain code; no model is called here.
 */
import { createHash } from "node:crypto";
import type { LastAssistant, ThreadState } from "./adapter.ts";
import { looksLikeAsk } from "./decide.ts";

/**
 * Pure: can this thread be an idle parent? Top level (no child or subagent), not settled, snoozed or archived, finished
 * (`idle` or `completed`, so not waiting on a card, running, failed or interrupted), with nothing of its own still running, and
 * not one of the threads that belong to Chamberlain itself or the operator's exclude list (`skip`: the Steward, the decisions
 * thread, the Alert Desk).
 */
export function idleParentCandidate(th: ThreadState, skip: ReadonlySet<string>, liveChildren = 0): boolean {
	return (
		th.parentThreadId === null &&
		!th.settled &&
		!th.snoozed &&
		!th.archived &&
		(th.status === "idle" || th.status === "completed") &&
		th.pendingRequestId === null &&
		th.backgroundTasks === 0 &&
		liveChildren === 0 &&
		!skip.has(th.id)
	);
}

/**
 * One idle thread, as plain data. `lastMessage` is the whole text; `lastMessageHash` names that message (id and text). `previous` is the
 * user message before it and who wrote it (`none`: there is none, or the adapter cannot say); only the classifier reads it.
 */
export type IdleThread = {
	server: string;
	threadId: string;
	title: string;
	idleMinutes: number;
	lastMessage: string;
	lastMessageHash: string;
	looksLikeAsk: boolean;
	previous: { from: "human" | "agent" | "none"; text: string };
};

/** What a watcher offers the selection: its threads as it last saw them, and how to read one thread's last message. */
export type IdleThreadSource = {
	server: string;
	connected: boolean;
	threads: Iterable<ThreadState>;
	/** Running children of a thread (their completion wakes it, so it is not idle). */
	liveChildren(threadId: string): number;
	/**
	 * Subagents the thread itself runs, which its own projection knows and the thread table does not (the turn-end path asks the same:
	 * Inspector.runningSubagents). A thread with any running is not idle. Absent: the adapter cannot say.
	 */
	runningSubagents?: (threadId: string) => Promise<number>;
	/** Absent: this adapter's threads cannot be read, so none is selected. */
	lastAssistant?: (threadId: string) => Promise<LastAssistant | undefined>;
	/** Called once for a thread whose read threw. */
	readFailed?: (threadId: string, error: unknown) => void;
};

/** What the selection found: the idle threads, and those it could not read (kept as they were, never read as cleared). */
export type IdleSelection = { threads: IdleThread[]; unreadable: { server: string; threadId: string }[] };

/** Pure: the identity of one last message, stable for the same message and different for the next one. */
export const messageHash = (last: Pick<LastAssistant, "id" | "text">): string =>
	createHash("sha256").update(`${last.id}\0${last.text}`).digest("hex").slice(0, 12);

/** Pure: asks first, then the longest idle, then by server and thread, so the order is the same on every run. */
const byAskThenIdle = (a: IdleThread, b: IdleThread): number =>
	Number(b.looksLikeAsk) - Number(a.looksLikeAsk) ||
	b.idleMinutes - a.idleMinutes ||
	(`${a.server}\0${a.threadId}` < `${b.server}\0${b.threadId}` ? -1 : 1);

/**
 * THE idle-thread selection. From each source's threads: the candidates (`idleParentCandidate`) whose last finished assistant message
 * ended more than `thresholdMinutes` before `now`, as plain records, asks first and then the longest idle. A disconnected source, or a
 * thread whose read throws, is `unreadable` (its earlier report stays as it was). No model is called: `looksLikeAsk` is a regular
 * expression. Reads go a few at a time, one projection each.
 */
export async function selectIdleThreads(
	sources: readonly IdleThreadSource[],
	now: number,
	o: { thresholdMinutes: number; skip?: ReadonlySet<string> },
): Promise<IdleSelection> {
	const skip = o.skip ?? new Set<string>();
	const out: IdleSelection = { threads: [], unreadable: [] };
	for (const src of sources) await selectFromSource(src, { now, thresholdMinutes: o.thresholdMinutes, skip }, out);
	out.threads.sort(byAskThenIdle);
	return out;
}

/** One source's part of the selection: its candidates read eight at a time, or all of them unreadable when it is not connected. */
async function selectFromSource(
	src: IdleThreadSource,
	{ now, thresholdMinutes, skip }: { now: number; thresholdMinutes: number; skip: ReadonlySet<string> },
	out: IdleSelection,
): Promise<void> {
	const read = src.lastAssistant;
	if (!read) return;
	const candidates = [...src.threads].filter((th) => idleParentCandidate(th, skip, src.liveChildren(th.id)));
	if (!src.connected) {
		for (const th of candidates) out.unreadable.push({ server: src.server, threadId: th.id });
		return;
	}
	const job: IdleRead = { src, read, now, thresholdMinutes, out };
	const one = (th: ThreadState) => readIdleThread(job, th);
	for (let i = 0; i < candidates.length; i += 8) await Promise.all(candidates.slice(i, i + 8).map(one));
}

/** One candidate's read: idle past the threshold it joins `out.threads`; a read that throws is `unreadable` and is told to the source. */
type IdleRead = {
	src: IdleThreadSource;
	read: NonNullable<IdleThreadSource["lastAssistant"]>;
	now: number;
	thresholdMinutes: number;
	out: IdleSelection;
};

async function readIdleThread({ src, read, now, thresholdMinutes, out }: IdleRead, th: ThreadState): Promise<void> {
	try {
		if (src.runningSubagents && (await src.runningSubagents(th.id)) > 0) return;
		const last = await read(th.id);
		const at = last ? Date.parse(last.at) : Number.NaN;
		if (!last || !Number.isFinite(at)) return;
		const idleMs = now - at;
		if (idleMs <= thresholdMinutes * 60_000) return;
		out.threads.push({
			server: src.server,
			threadId: th.id,
			title: th.title,
			idleMinutes: Math.floor(idleMs / 60_000),
			lastMessage: last.text,
			lastMessageHash: messageHash(last),
			looksLikeAsk: looksLikeAsk(last.text),
			previous: last.previous ? { from: last.previous.by, text: last.previous.text } : { from: "none", text: "" },
		});
	} catch (e) {
		src.readFailed?.(th.id, e);
		out.unreadable.push({ server: src.server, threadId: th.id });
	}
}
