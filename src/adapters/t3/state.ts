/**
 * T3's thread, as the core reads it: the shell stream's raw thread record turned into a ThreadState, and T3's names
 * for the kinds of waiting item turned into the core's.
 */
import type { ThreadState, WaitKind } from "../../core/adapter.ts";

type RawPr = { number?: unknown; snapshot?: { state?: unknown } | null } | null;
type RawTask = { taskId?: unknown } | null;
type Raw = {
	id?: unknown;
	title?: unknown;
	status?: unknown;
	snoozedUntil?: string | null;
	lineage?: { parentThreadId?: string | null } | null;
	pendingRuntimeRequest?: { id?: unknown } | null;
	settledAt?: unknown;
	unsettledAt?: unknown;
	archivedAt?: unknown;
	blockedOnThreadWait?: unknown;
	pullRequests?: RawPr[];
	worktreePath?: unknown;
	pendingBackgroundTasks?: unknown;
	latestRunId?: unknown;
	[field: string]: unknown;
};
const prState = (p: RawPr | undefined) => String(p?.snapshot?.state ?? "").toLowerCase();

/** T3 names the machine-pairing card differently across versions; every variant is a link request. */
export const normalizeWaitKind = (type: string): string => (/link/i.test(type) ? "link_request" : type);
/** Whether a turn item's type is one of the kinds of waiting item the core knows. */
export const isWaitKind = (type: string): type is WaitKind =>
	["user_input_request", "approval_request", "secret_request", "link_request"].includes(normalizeWaitKind(type));

/** Pure: a timestamp field that is set: a string that parses as a date. Anything else (`{}`, `true`, a number, junk text) is not. */
const isStamp = (v: unknown): boolean => typeof v === "string" && Number.isFinite(Date.parse(v));

export function toState(t: Raw, now = Date.now()): ThreadState {
	const snoozedUntil = t.snoozedUntil ? Date.parse(t.snoozedUntil) : 0;
	return {
		id: String(t.id),
		title: String(t.title ?? ""),
		status: String(t.status ?? "idle"),
		parentThreadId: t.lineage?.parentThreadId ?? null,
		pendingRequestId: t.pendingRuntimeRequest?.id ? String(t.pendingRuntimeRequest.id) : null,
		settled: isStamp(t.settledAt) && !t.unsettledAt,
		// Archived only on a real timestamp: `archivedAt: {}` is not one. Nothing closes a card hold on it either way (card-hold.ts).
		archived: isStamp(t.archivedAt),
		snoozed: snoozedUntil > now,
		blockedOnThreadWait: Boolean(t.blockedOnThreadWait),
		// branchPullRequest carries no state, so the linked list is the only source for it.
		openPrs: [
			...new Set((t.pullRequests ?? []).filter((p) => prState(p) === "open").map((p) => Number(p?.number))),
		] as number[],
		worktreePath: t.worktreePath ? String(t.worktreePath) : null,
		linkedPrDone: (t.pullRequests ?? []).some((p) => ["merged", "closed"].includes(prState(p))),
		backgroundTasks: Array.isArray(t.pendingBackgroundTasks) ? t.pendingBackgroundTasks.length : 0,
		backgroundWork: Array.isArray(t.pendingBackgroundTasks)
			? (t.pendingBackgroundTasks as RawTask[]).filter((x) => !String(x?.taskId).startsWith("pull-request-watch:"))
					.length
			: 0,
		latestRunId: t.latestRunId ? String(t.latestRunId) : null,
	};
}
