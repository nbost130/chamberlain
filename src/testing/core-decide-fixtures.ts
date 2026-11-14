import type { ThreadState } from "../core/decide.ts";

export const base: ThreadState = {
	id: "t1",
	title: "T",
	status: "running",
	parentThreadId: null,
	pendingRequestId: null,
	settled: false,
	archived: false,
	snoozed: false,
	blockedOnThreadWait: false,
	openPrs: [],
	worktreePath: null,
	linkedPrDone: false,
	backgroundTasks: 0,
	backgroundWork: 0,
};

export const none = new Set<string>();
