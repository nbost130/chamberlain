import { principal } from "./config.ts";
import type { ThreadState, WakeKind } from "./adapter.ts";

/** Pure rules: which thread transitions are worth waking the Steward for. They read the normalized ThreadState (adapter.ts). */
export type { ThreadState, WakeKind, WaitQuestion } from "./adapter.ts";
export type Candidate = { kind: WakeKind; thread: ThreadState; key: string };

export const LIVE = new Set(["running", "queued", "starting", "preparing", "waiting"]);
const ENDED = new Set(["completed", "idle", "interrupted"]);

/** Transitions worth a wake. `prev` undefined means first sighting: nothing fires. */
export function decide(
	prev: ThreadState | undefined,
	next: ThreadState,
	exclude: ReadonlySet<string>,
): Candidate[] {
	if (exclude.has(next.id) || next.archived || next.settled || next.snoozed) return [];
	if (!prev) return next.pendingRequestId ? [{ kind: "needs_input", thread: next, key: `${next.id}:input:${next.pendingRequestId}` }] : [];
	const out: Candidate[] = [];
	const topLevel = next.parentThreadId === null;
	if (next.pendingRequestId && next.pendingRequestId !== prev.pendingRequestId)
		out.push({ kind: "needs_input", thread: next, key: `${next.id}:input:${next.pendingRequestId}` });
	else if (next.status === "waiting" && prev.status !== "waiting" && !next.blockedOnThreadWait)
		out.push({ kind: "needs_input", thread: next, key: `${next.id}:waiting:${Date.now()}` });
	if (topLevel && next.status === "failed" && prev.status !== "failed")
		out.push({ kind: "failed", thread: next, key: `${next.id}:failed:${prev.status}` });
	if (topLevel && LIVE.has(prev.status) && ENDED.has(next.status))
		out.push({ kind: "turn_ended", thread: next, key: `${next.id}:ended:${Date.now()}` });
	return out;
}

export type WaitItem = { type: string; requestId: string };
/** Waiting items only the human can clear: command approvals, secrets, and pairing one T3 machine with another. */
export const OPERATOR_ONLY_KINDS = new Set(["approval_request", "secret_request", "link_request"]);
/**
 * Where a needs_input wake goes, decided in code so a model turn is spent only when it can help.
 * skip-empty: the thread shows "waiting" with no request behind it (nothing to answer).
 * hold: while away, every waiting item is one only the human can clear, so the daemon records it
 * for the return brief instead of waking anyone.
 */
export function routeNeedsInput(items: WaitItem[], hasPendingRequest: boolean, away: boolean): "wake" | "hold" | "skip-empty" {
	if (!items.length) return hasPendingRequest ? "wake" : "skip-empty";
	if (away && items.every((i) => OPERATOR_ONLY_KINDS.has(i.type))) return "hold";
	return "wake";
}

/** True when a finished turn's final message promises work it then did not do ("starts next", "I'll now begin"). */
export function looksLikeStall(text: string): boolean {
	// Sign-off lines some agent setups append (a line that starts with a speaker or robot emoji) are not the turn's content.
	const body = text
		.split("\n")
		.filter((l) => !/^\s*(🗣️|🧠|🤖|⚙️)/.test(l))
		.join("\n")
		.trim();
	if (!body) return false;
	const wait = /\b(when|once|after)\b[^.\n]{0,80}\b(finish(es)?|pass(es|ed)?|complete[sd]?|done|ready)\b[^.\n]{0,40}\b(i'?ll|i will|we'?ll)\b|\b(stays?|keeps?|remains?) (working|running|parked) until\b/i.test(body.slice(-900));
	if (wait) return true;
	return /\b(starts? next|next up|(i'?ll|i will|we'?ll) (now |next )?(start|begin|proceed|build|move on)|will (now )?(start|begin) (next|now)|now (starting|building|moving on))\b/i.test(body.slice(-900));
}

/**
 * Phrases that hand finished work back to the operator for authorization without asking anything: "handing it back",
 * "installation remains held", "held until/for your ...", "your last approval covered X only", "needs your go-ahead",
 * "before activation". Read against the whole message tail, sign-off lines included, because a hand-back is often
 * said only in a spoken closing line. Narrow on purpose: a bare "handed back to the Steward" or "remains ready and
 * unmerged" is a report, not an ask.
 */
const HANDBACK =
	/\bhanding (?:it|this|that|them|everything) back\b(?! to (?:the )?steward)|\bremains? held\b|\bheld (?:until|for) your\b|\byour (?:last |latest |previous )?approval (?:only )?covered\b[^.\n]{0,120}\bonly\b|\bneeds? your (?:approval|go-ahead|go ahead|ok|okay)\b|\bbefore (?:live )?activation\b/i;

/** True when a finished turn's final message hands a question or decision back to the operator. */
export function looksLikeAsk(text: string): boolean {
	if (HANDBACK.test(text.trim().slice(-500))) return true;
	const body = text
		.split("\n")
		.filter((l) => !l.trimStart().startsWith("🗣️") && !l.trimStart().startsWith("🧠") && !l.trimStart().startsWith("🤖"))
		.join("\n")
		.trim();
	if (!body) return false;
	if (/❓\s*OPEN/i.test(body)) return true;
	const tail = body.slice(-500);
	if (/\b(tell me when|let me know|say if|say the word|want me to|shall i|should i|your call|do you want|awaiting your|waiting (?:on|for) your|until you (?:decide|answer|confirm|say))\b/i.test(tail)) return true;
	// A /goal proposal waits for an answer ("Submit the /goal block as-is, edit it, or say 'no goal'") but ends on no question mark.
	if (/\bsubmit the \/goal\b|\bsay ['"‘’“”]?no goal\b/i.test(tail)) return true;
	return /\?\s*$/m.test(tail.split("\n").filter((l) => l.trim()).slice(-2).join("\n"));
}

export type TurnItem = { type?: string; id?: string; runId?: string; text?: string; createdBy?: string; creationSource?: string; updatedAt?: string };
/**
 * The id of the Steward's message when that is the thread's latest instruction. Machine deliveries (a PR
 * update, a card answer, a delegate's result) arrive with source "server" and instruct nobody, so they are
 * skipped. A later message from anyone else means the thread is theirs now. T3 keeps no sender across
 * machines, so the Steward is known by how it signs its messages. This only decides whether a wake is
 * worth its tokens; it is never an authorization.
 */
export function stewardInstruction(items: TurnItem[]): string | undefined {
	for (const i of [...items].reverse()) {
		if (i.type !== "user_message" || i.creationSource === "server") continue;
		return i.createdBy === "agent" && i.creationSource === "mcp" && /^Steward\b/.test((i.text ?? "").trimStart()) ? i.id : undefined;
	}
	return undefined;
}

/** Pure: a turn just began. A thread can go straight from waiting on a card to working, which is why waiting does not count as working here. */
export function turnBegan(prev: ThreadState | undefined, next: ThreadState): boolean {
	const working = (s: string) => LIVE.has(s) && s !== "waiting";
	return prev !== undefined && working(next.status) && !working(prev.status);
}

/**
 * Pure: should a report-back still go when the quiet window ends? A card that was already open before this turn
 * began cannot cancel it: that card has had its own wake, and the thread has finished the work it was sent. A card
 * raised since then still wins, because it has a wake of its own.
 */
export function reportStillDue(after: ThreadState, oldCards: ReadonlySet<string>): boolean {
	if (after.settled || after.archived || after.snoozed) return false;
	const oldCard = after.pendingRequestId !== null && oldCards.has(after.pendingRequestId);
	if (after.pendingRequestId !== null && !oldCard) return false;
	return !LIVE.has(after.status) || (after.status === "waiting" && oldCard);
}

/** Machine deliveries instruct nobody, so they are never the latest instruction. */
export const lastInstruction = (items: TurnItem[]) => [...items].reverse().find((i) => i.type === "user_message" && i.creationSource !== "server");
/** Pure: the thread's latest instruction is the principal's own, from within this window. They are driving it, so its turns are not a runaway. */
export function principalWroteWithin(items: TurnItem[], now: number, windowMs: number): boolean {
	const last = lastInstruction(items);
	return last?.createdBy === "user" && now - Date.parse(last.updatedAt ?? "") < windowMs;
}

export const REPORT_WAKES_MAX = 3;
/**
 * Pure: the report wake these items may use, when their latest instruction came from the Steward. A machine's turn
 * spends none of the three, but it can carry the real final report, so it gets one wake of its own per instruction.
 */
export function reportKey(items: TurnItem[], byMachine: boolean, notified: { has(key: string): boolean }): string | undefined {
	const id = stewardInstruction(items);
	if (!id) return undefined;
	if (byMachine) return notified.has(`report:${id}:machine`) ? undefined : `report:${id}:machine`;
	for (let n = 0; n < REPORT_WAKES_MAX; n++) if (!notified.has(`report:${id}:${n}`)) return `report:${id}:${n}`;
	return undefined;
}

export const PRINCIPAL_HERE_MS = 30 * 60_000;
/**
 * Pure: the wake key for a thread that went idle, or undefined when its latest instruction rules one out. One wake
 * per instruction, so a thread only comes back after someone gives it more to do. The principal's own recent message means
 * they are in the thread already, and machine deliveries instruct nobody.
 */
export function idleKey(items: TurnItem[], now: number): string | undefined {
	const last = lastInstruction(items);
	if (!last?.id || principalWroteWithin(items, now, PRINCIPAL_HERE_MS)) return undefined;
	return `idle:${last.id}`;
}

/** Pure: how the wake names the open work. */
export const idleWorkLine = (openPrs: number[], commits: number) =>
	openPrs.length ? `open PR ${openPrs.map((n) => `#${n}`).join(", ")}` : `${commits} unmerged commit${commits === 1 ? "" : "s"} on its branch and no open PR`;

/** True when the Steward's context has passed the limit and no compaction was sent in the cooldown. */
export function needsCompact(usedTokens: number | undefined, limit: number, coolingDown: boolean): boolean {
	return !coolingDown && usedTokens !== undefined && usedTokens > limit;
}

export type RightsSent = { hash: string; used?: number };
export const RIGHTS_UNCHANGED = "Decision rights: unchanged since your last wake and still in force. They are in decision-rights.md in the config directory, and the rulings in force are listed in the hand-off (`bun src/brief.ts steward`).";
export const rightsUnreadable = () => `Decision rights: the daemon could not read them on this wake. Hold anything on the ASK list and tell ${principal()}.`;
/** The marker that starts the full rights block in a wake; hold.ts folds repeated copies of everything after it. */
export const RIGHTS_MARKER = "Decision rights (standing rules):";
/**
 * Pure: does this wake carry the full rights? Only when the Steward might not hold them: nothing recorded, they
 * changed, its context size is unknown, or its context shrank, which means a compaction or a new thread.
 */
export function rightsInFull(sent: RightsSent | undefined, hash: string, used: number | undefined): boolean {
	if (!sent || sent.hash !== hash) return true;
	if (used === undefined || sent.used === undefined) return true;
	return used < sent.used;
}

/** The waiting questions and their options as plain text, clipped to what a wake should carry. */
export function questionText(questions: import("./adapter.ts").WaitQuestion[], max = 1200): string {
	const text = questions
		.map((q) => [q.question ?? "", ...(q.options ?? []).map((o) => `- ${o.label ?? ""}${o.description ? `: ${o.description.slice(0, 120)}` : ""}`)].join("\n"))
		.join("\n\n");
	return text.length > max ? `${text.slice(0, max)}…` : text;
}
