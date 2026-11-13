/**
 * T3's thread, as the core reads it: the shell stream's raw thread record turned into a ThreadState, and T3's names
 * for the kinds of waiting item turned into the core's.
 */
import type { ThreadState, WaitKind } from "../../core/adapter.ts";

type Raw = Record<string, any>;
const prState = (p: any) => String(p?.snapshot?.state ?? "").toLowerCase();

/** T3 names the machine-pairing card differently across versions; every variant is a link request. */
export const normalizeWaitKind = (type: string): string => (/link/i.test(type) ? "link_request" : type);
/** Whether a turn item's type is one of the kinds of waiting item the core knows. */
export const isWaitKind = (type: string): type is WaitKind => ["user_input_request", "approval_request", "secret_request", "link_request"].includes(normalizeWaitKind(type));

export function toState(t: Raw, now = Date.now()): ThreadState {
	const snoozedUntil = t.snoozedUntil ? Date.parse(t.snoozedUntil) : 0;
	return {
		id: String(t.id),
		title: String(t.title ?? ""),
		status: String(t.status ?? "idle"),
		parentThreadId: t.lineage?.parentThreadId ?? null,
		pendingRequestId: t.pendingRuntimeRequest?.id ? String(t.pendingRuntimeRequest.id) : null,
		settled: Boolean(t.settledAt) && !t.unsettledAt,
		archived: Boolean(t.archivedAt),
		snoozed: snoozedUntil > now,
		blockedOnThreadWait: Boolean(t.blockedOnThreadWait),
		// branchPullRequest carries no state, so the linked list is the only source for it.
		openPrs: [...new Set((t.pullRequests ?? []).filter((p: any) => prState(p) === "open").map((p: any) => Number(p.number)))] as number[],
		worktreePath: t.worktreePath ? String(t.worktreePath) : null,
		linkedPrDone: (t.pullRequests ?? []).some((p: any) => ["merged", "closed"].includes(prState(p))),
		backgroundTasks: Array.isArray(t.pendingBackgroundTasks) ? t.pendingBackgroundTasks.length : 0,
		backgroundWork: Array.isArray(t.pendingBackgroundTasks) ? t.pendingBackgroundTasks.filter((x: any) => !String(x?.taskId).startsWith("pull-request-watch:")).length : 0,
	};
}

