/**
 * The pure half of T3's waiting-card mirror: what one thread's waiting turn items make as queue entries (a question, an
 * approval, a secret or link request, a goal proposal), and the fingerprint each carries. Nothing here reads or answers.
 */
import { createHash } from "node:crypto";
import type { WaitingCard } from "../../core/adapter.ts";
import { OPERATOR_ONLY_KINDS } from "../../core/decide.ts";
import { tagIn } from "../../core/questions.ts";
import { normalizeWaitKind } from "./state.ts";

type Question = {
	id: string;
	header?: string;
	question?: string;
	multiSelect?: boolean;
	options?: { label: string; description?: string }[];
};
export type TurnItem = {
	type: string;
	status: string;
	requestId?: string;
	id?: string;
	messageId?: string | null;
	text?: string;
	questions?: Question[];
	prompt?: string;
	reason?: string;
	label?: string;
	url?: string;
	appName?: string;
	requestKind?: string;
	fullAccessOverride?: unknown;
	options?: unknown;
	/** A secret request's own outcome (T3: pending, saved, declined, cancelled) and the run whose agent waits on it. */
	secretStatus?: string;
	runId?: string | null;
};
export type Run = { id?: string; status?: string };
/** The run statuses T3 counts as ended (ThreadManagementService `isTerminalRunStatus`). */
const RUN_ENDED = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);
/**
 * Pure: does a secret request still wait on the operator, as T3 itself counts it? Its `secretStatus` (when T3 gives one) is still
 * "pending", and the run whose agent asked has not ended (T3's shell lists a secret only while that run is live: its agent's wait, which
 * alone can hand the value on, timed out or died with it). A run the read does not show is not counted as ended.
 */
export function secretWaits(i: Pick<TurnItem, "secretStatus" | "runId">, runs: readonly Run[] = []): boolean {
	if (i.secretStatus !== undefined && i.secretStatus !== "pending") return false;
	const run = i.runId ? runs.find((r) => r.id === i.runId) : undefined;
	return !(run && RUN_ENDED.has(String(run.status ?? "")));
}
/** A thread in the shell snapshot (field names as T3 sends them; see toState in src/core/decide.ts). */
export type ShellThread = {
	id: string;
	title?: string;
	pendingRuntimeRequest?: { id?: string } | null;
	archivedAt?: string | null;
	status?: string;
	updatedAt?: string;
	settledAt?: string | null;
	unsettledAt?: string | null;
};

export type MirrorCard = WaitingCard;

export const mirrorId = (server: string, requestId: string) =>
	`C-${createHash("sha256").update(`${server}\0${requestId}`).digest("hex").slice(0, 12)}`;
const RECOMMENDED = /\s*\(Recommended[^)]*\)\s*$/i;
/** Pure: a fingerprint of everything the card asks (ids, text, options in order, multiSelect). */
const cardSig = (questions: unknown) =>
	createHash("sha256")
		.update(JSON.stringify(questions ?? null))
		.digest("hex")
		.slice(0, 16);
/** Where a card comes from: the server and thread it waits on, whether it can be answered here, and its thread's link. */
export type CardScope = { server: string; canAnswer: boolean; thread: ShellThread; link?: string };

/** Pure: the question cards in one thread's turn items, as queue entries. Everything else waiting is left out. */
export function cardsFrom(scope: CardScope, items: TurnItem[], runs: readonly Run[] = []): MirrorCard[] {
	const out: MirrorCard[] = [];
	for (const i of items) {
		if (i.status !== "waiting") continue;
		// A secret box whose request ended (its agent's wait timed out or its run is over) is no longer waiting, even if its item says so.
		if (normalizeWaitKind(String(i.type)) === "secret_request" && !secretWaits(i, runs)) continue;
		const card = cardFor(scope, i);
		if (card) out.push(card);
	}
	return out;
}

/** Pure: the entry one waiting turn item makes, by its kind (an approval, a secret or link request, a question), or none. */
function cardFor(scope: CardScope, i: TurnItem): MirrorCard | undefined {
	const kind = normalizeWaitKind(String(i.type));
	if (i.type === "approval_request") return approvalCard(scope, i);
	if (OPERATOR_ONLY_KINDS.has(kind)) return readOnly(scope, i, kind);
	if (i.type !== "user_input_request") return undefined;
	return questionCard(scope, i);
}

/** Pure: a question as a queue entry; none when it has no request id or no questions, or is already a queue item (tagged). */
function questionCard(scope: CardScope, i: TurnItem): MirrorCard | undefined {
	const { server, thread, link } = scope;
	const requestId = String(i.requestId ?? "");
	const qs = i.questions ?? [];
	if (!requestId || !qs.length) return undefined;
	if (qs.some((q) => tagIn(`${q.id} ${q.header ?? ""} ${q.question ?? ""}`))) return undefined;
	const q = qs[0];
	if (!q) return undefined;
	const options = (q.options ?? []).map((o) => ({
		label: o.label.replace(RECOMMENDED, "").trim(),
		...(o.description && o.description !== o.label ? { detail: o.description } : {}),
	}));
	const rec = (q.options ?? []).findIndex((o) => RECOMMENDED.test(o.label));
	const why = questionWhy(scope, qs, q, options.length);
	return {
		id: mirrorId(server, requestId),
		type: "question",
		server,
		threadId: thread.id,
		threadTitle: thread.title ?? "(untitled thread)",
		requestId,
		...(q.header ? { header: q.header } : {}),
		question: q.question ?? q.header ?? "",
		options,
		...(rec >= 0 ? { recommended: rec } : {}),
		answerable: !why,
		...(why ? { why } : {}),
		...(link ? { link } : {}),
		sig: cardSig(qs),
	};
}

/** Pure: why a question cannot be answered from the page, or undefined when it can. */
function questionWhy(
	{ server, canAnswer }: CardScope,
	qs: Question[],
	q: Question,
	optionCount: number,
): string | undefined {
	if (!canAnswer) return `answer it in its thread on ${server}`;
	if (qs.length > 1) return "it asks several questions: answer it in its thread";
	if (q.multiSelect) return "it allows several choices: answer it in its thread";
	if (!optionCount) return "it wants a written answer: answer it in its thread";
	return undefined;
}

const one = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/**
 * Pure: an approval as a queue entry. Answerable only with an operate token and a non-empty command. Its fingerprint
 * covers every field T3 shows for it, so any change, even one byte of the command, refuses an answer given to the old one.
 */
export function approvalCard(scope: CardScope, i: TurnItem): MirrorCard | undefined {
	const { server, canAnswer, thread, link } = scope;
	const requestId = String(i.requestId ?? "");
	if (!requestId) return undefined;
	const command = typeof i.prompt === "string" ? i.prompt : "";
	const why = approvalWhy(server, canAnswer, command);
	const sig = cardSig({
		type: i.type,
		requestId,
		requestKind: i.requestKind ?? null,
		prompt: i.prompt ?? null,
		reason: i.reason ?? null,
		appName: i.appName ?? null,
		fullAccessOverride: i.fullAccessOverride ?? null,
		options: i.options ?? null,
	});
	return {
		id: mirrorId(server, requestId),
		type: "approval",
		server,
		threadId: thread.id,
		threadTitle: thread.title ?? "(untitled thread)",
		requestId,
		header: "Approval",
		question:
			[one(i.requestKind), one(i.reason), i.appName ? `(${one(i.appName)})` : ""].filter(Boolean).join(" · ") ||
			"Approval",
		command,
		options: why ? [] : [{ label: "Approve once" }, { label: "Decline" }],
		answerable: !why,
		...(why ? { why } : {}),
		...(link ? { link } : {}),
		sig,
	};
}

/** Pure: why an approval cannot be answered from the page, or undefined when it can. */
function approvalWhy(server: string, canAnswer: boolean, command: string): string | undefined {
	if (!canAnswer) return `approve or decline it in its thread on ${server}`;
	if (!command.trim()) return "it shows no command: approve or decline it in its thread";
	return undefined;
}

/** Pure: a secret or link request as a read-only entry. Never answerable; a secret's value is never asked for. */
function readOnly({ server, thread, link }: CardScope, i: TurnItem, kind: string): MirrorCard | undefined {
	const requestId = String(i.requestId ?? i.id ?? "");
	if (!requestId) return undefined;
	const [type, header, question, why] =
		kind === "secret_request"
			? [
					"secret",
					"Secret request",
					[one(i.label), one(i.reason)].filter(Boolean).join(" · "),
					"enter it in its thread; secrets are never entered here",
				]
			: [
					"link",
					"Link request",
					[one(i.label) || one(i.url) || "link two T3 machines", one(i.reason)].filter(Boolean).join(" · "),
					"approve it in its thread",
				];
	return {
		id: mirrorId(server, requestId),
		type: type as MirrorCard["type"],
		server,
		threadId: thread.id,
		threadTitle: thread.title ?? "(untitled thread)",
		requestId,
		header,
		question: question || header,
		options: [],
		answerable: false,
		why,
		...(link ? { link } : {}),
		sig: cardSig([kind, requestId]),
	};
}

/** Pure: the /goal text a thread is waiting on the principal to accept, if its last message proposes one. */
export function goalProposal(items: TurnItem[]): { messageId: string; goal: string } | undefined {
	const msgs = items.filter((i) => i.type === "assistant_message" || i.type === "user_message");
	const last = msgs.at(-1);
	if (last?.type !== "assistant_message" || last.status !== "completed" || typeof last.text !== "string")
		return undefined;
	const blocks = [...last.text.matchAll(/```[a-z]*\n(\/goal [\s\S]*?)\n```/g)].map(([, block = ""]) => block.trim());
	const goal = blocks.at(-1);
	const messageId = String(last.messageId ?? last.id ?? "");
	return goal && messageId ? { messageId, goal } : undefined;
}

export const BUSY = new Set(["running", "starting", "preparing", "queued", "waiting"]);

/** Pure: a goal proposal as a queue entry. Accepting sends the exact /goal text; it needs an operate token. */
export function goalCard(
	{ server, canAnswer, thread, link }: CardScope,
	p: { messageId: string; goal: string },
): MirrorCard {
	const why = canAnswer ? undefined : `accept it in its thread on ${server}`;
	return {
		id: mirrorId(server, `goal:${p.messageId}`),
		type: "goal",
		server,
		threadId: thread.id,
		threadTitle: thread.title ?? "(untitled thread)",
		requestId: `goal:${p.messageId}`,
		header: "Goal proposal",
		question: one((p.goal.split("\n")[0] ?? "").replace(/^\/goal\s+/, "")),
		command: p.goal,
		options: why ? [] : [{ label: "Accept goal" }],
		answerable: !why,
		...(why ? { why } : {}),
		...(link ? { link } : {}),
		sig: cardSig({ kind: "goal", messageId: p.messageId, goal: p.goal }),
	};
}
