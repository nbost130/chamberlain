/**
 * T3's side of the waiting-card mirror (`listWaiting` and `answer` of the adapter contract): reads everything waiting on
 * the operator in one T3 server's threads and answers a card back through T3's own command, after re-reading it. Bounds:
 * - Question cards (`user_input_request`) can be answered here.
 * - Approvals (`approval_request`) can be approved once or declined here. Never "always" or "for this session". The
 *   command is shown exactly as T3 holds it, the answer must carry the fingerprint of what was shown, the view asks for
 *   a confirm tap, and every answer is logged with the full command text.
 * - Secret and link requests are listed read-only with a link to their thread, permanently: never answerable here.
 * - Goal proposals: a thread whose last message is a finished assistant message carrying a fenced `/goal …` block,
 *   with no reply after it and no run going. "Accept goal" sends that exact /goal text to the thread as the
 *   principal's message, the way they accept one by hand.
 * - A card on a server with an operate token can be answered; the answer goes straight to the card in its own thread
 *   through runtime-request.respond. A server without one is shown read-only.
 * - A card carrying a queue item tag ([Q-…]) is left out: those questions are already queue items.
 * What is generic (one list across servers, the unreachable record, one answer per card) lives in src/web/waiting.ts.
 */
import { createHash } from "node:crypto";
import {
	CALL_TIMEOUT_MS,
	createRpcPing,
	messageCommand,
	openWithin,
	readToken,
	redact,
	stableId,
	within,
} from "./ping.ts";
import { connect, type Rpc } from "./rpc.ts";

// The one send path lives in ./ping.ts; these are re-exported because the page and the tests import them from here.
export { CALL_TIMEOUT_MS, redact, stableId, within };

import type { AnswerOutcome, ListWaitingOptions, ThreadLinks, WaitingCard } from "../../core/adapter.ts";
import { OPERATOR_ONLY_KINDS } from "../../core/decide.ts";
import { tagIn } from "../../core/questions.ts";
import { checkProjection } from "./projection.ts";
import type { T3Server } from "./server.ts";
import { normalizeWaitKind } from "./state.ts";

export type Server = Pick<T3Server, "name" | "origin" | "tokenFile" | "operateTokenFile">;
type Question = {
	id: string;
	header?: string;
	question?: string;
	multiSelect?: boolean;
	options?: { label: string; description?: string }[];
};
type TurnItem = {
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
type Run = { id?: string; status?: string };
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
type ShellThread = {
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

export const MIRROR_ID = /^C-[a-f0-9]{12}$/;
export const mirrorId = (server: string, requestId: string) =>
	`C-${createHash("sha256").update(`${server}\0${requestId}`).digest("hex").slice(0, 12)}`;
const RECOMMENDED = /\s*\(Recommended[^)]*\)\s*$/i;
/** Pure: a fingerprint of everything the card asks (ids, text, options in order, multiSelect). */
export const cardSig = (questions: unknown) =>
	createHash("sha256")
		.update(JSON.stringify(questions ?? null))
		.digest("hex")
		.slice(0, 16);
/** Pure: the message with every secret in it replaced, for logs and error bodies. */
/** Pure: the question cards in one thread's turn items, as queue entries. Everything else waiting is left out. */
export function cardsFrom(
	server: string,
	canAnswer: boolean,
	thread: ShellThread,
	items: TurnItem[],
	link?: string,
	runs: readonly Run[] = [],
): MirrorCard[] {
	const out: MirrorCard[] = [];
	for (const i of items) {
		if (i.status !== "waiting") continue;
		// A secret box whose request ended (its agent's wait timed out or its run is over) is no longer waiting, even if its item says so.
		if (normalizeWaitKind(String(i.type)) === "secret_request" && !secretWaits(i, runs)) continue;
		const card = cardFor(server, canAnswer, thread, i, link);
		if (card) out.push(card);
	}
	return out;
}

/** Pure: the entry one waiting turn item makes, by its kind (an approval, a secret or link request, a question), or none. */
function cardFor(
	server: string,
	canAnswer: boolean,
	thread: ShellThread,
	i: TurnItem,
	link?: string,
): MirrorCard | undefined {
	const kind = normalizeWaitKind(String(i.type));
	if (i.type === "approval_request") return approvalCard(server, canAnswer, thread, i, link);
	if (OPERATOR_ONLY_KINDS.has(kind)) return readOnly(server, thread, i, kind, link);
	if (i.type !== "user_input_request") return undefined;
	return questionCard(server, canAnswer, thread, i, link);
}

/** Pure: a question as a queue entry; none when it has no request id or no questions, or is already a queue item (tagged). */
function questionCard(
	server: string,
	canAnswer: boolean,
	thread: ShellThread,
	i: TurnItem,
	link?: string,
): MirrorCard | undefined {
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
	const why = questionWhy(server, canAnswer, qs, q, options.length);
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
	server: string,
	canAnswer: boolean,
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

/** The only decisions the page can send for an approval, by option index. Never "always" or "for this session". */
export const APPROVAL_DECISIONS = ["accept", "decline"] as const;

/**
 * Pure: an approval as a queue entry. Answerable only with an operate token and a non-empty command. Its fingerprint
 * covers every field T3 shows for it, so any change, even one byte of the command, refuses an answer given to the old one.
 */
function approvalCard(
	server: string,
	canAnswer: boolean,
	thread: ShellThread,
	i: TurnItem,
	link?: string,
): MirrorCard | undefined {
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
function readOnly(
	server: string,
	thread: ShellThread,
	i: TurnItem,
	kind: string,
	link?: string,
): MirrorCard | undefined {
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

/** The first shell snapshot of a server: every thread with its waiting request, if any. */
async function snapshot(rpc: Rpc, timeoutMs = 10_000): Promise<ShellThread[]> {
	return await new Promise<ShellThread[]>((resolve, reject) => {
		const timer = setTimeout(() => reject(Error("snapshot timed out")), timeoutMs);
		rpc
			.call("orchestration.subscribeShell", {}, (v) => {
				if (v?.kind === "snapshot" && v.snapshot) {
					clearTimeout(timer);
					// A snapshot with no thread list, or a thread with no id, is malformed: an empty mirror would say nothing waits.
					const threads: unknown = v.snapshot.threads;
					if (
						!Array.isArray(threads) ||
						!threads.every(
							(t) =>
								typeof t === "object" &&
								t !== null &&
								typeof (t as ShellThread).id === "string" &&
								(t as ShellThread).id !== "",
						)
					)
						reject(Error("malformed snapshot"));
					else resolve(threads as ShellThread[]);
				}
			})
			.catch((e) => {
				clearTimeout(timer);
				reject(e);
			});
	});
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

const BUSY = new Set(["running", "starting", "preparing", "queued", "waiting"]);

/** Pure: a goal proposal as a queue entry. Accepting sends the exact /goal text; it needs an operate token. */
export function goalCard(
	server: string,
	canAnswer: boolean,
	thread: ShellThread,
	p: { messageId: string; goal: string },
	link?: string,
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

export type WaitingDeps = {
	server: Server;
	conf: string;
	log: (event: string, data?: Record<string, unknown>) => void;
	connect?: (origin: string, token: string) => Promise<Pick<Rpc, "request" | "call"> & { ws: { close(): void } }>;
	/** Per-call deadline; tests shorten it. */
	timeoutMs?: number;
	/** The server's thread links (./links.ts). A card links to its thread through it unless the page gives a `linkBase`. */
	linker?: { links(threadId: string): ThreadLinks | undefined; ready(): Promise<void> };
};

/** What one T3 server's adapter is made of: its settings and the calls every read and answer goes through. */
type Ctx = {
	d: WaitingDeps;
	s: Server;
	ms: number;
	secrets: () => (string | undefined)[];
	/** A projection in the expected shape, or a throw (projection.ts): a malformed one never reads as "nothing waiting". */
	project: (rpc: { request: Rpc["request"] }, threadId: string) => Promise<Projected>;
	open: (token: string) => ReturnType<typeof openWithin>;
	/** server\0threadId -> the updatedAt last read and the proposal found then, so an unchanged thread isn't re-read. */
	goalSeen: Map<string, GoalSeen>;
};
type Projected = { turnItems: TurnItem[]; runs?: Run[] };
type GoalSeen = { updatedAt: string; proposal?: { messageId: string; goal: string } };
type Conn = Awaited<ReturnType<typeof openWithin>>;
const GOAL_WINDOW_MS = 7 * 24 * 3600_000;
const GOAL_READS_PER_POLL = 40;

/**
 * One T3 server's waiting cards: `listWaiting` reads them (and throws, with every token redacted, when the server can't
 * be read), `answer` answers one after re-reading it live, and `send` sends a message into a thread as the Steward.
 */
export function createT3Waiting(d: WaitingDeps) {
	const open = connect as unknown as NonNullable<WaitingDeps["connect"]>;
	const conn = d.connect ?? open;
	const s = d.server;
	const ms = d.timeoutMs ?? CALL_TIMEOUT_MS;
	const ctx: Ctx = {
		d,
		s,
		ms,
		secrets: () => [readToken(d.conf, s.tokenFile), readToken(d.conf, s.operateTokenFile)],
		project: async (rpc, threadId) =>
			checkProjection(
				await within(rpc.request("orchestration.getThreadProjection", { threadId }), ms, "projection read"),
			) as Projected,
		open: (token) => openWithin(conn, s.origin, token, ms),
		goalSeen: new Map(),
	};
	/** The adapter's `send`: the one ping (./ping.ts), signed as the Steward unless the caller names another identity. */
	const send = createRpcPing({ server: s, conf: d.conf, connect: conn, timeoutMs: ms });
	return {
		listWaiting: (o: ListWaitingOptions) => listWaitingOn(ctx, o),
		answer: (card: MirrorCard, choice: number, sig: string) => answerOn(ctx, card, choice, sig),
		send,
	};
}

/** What one listing reads: the open socket, the server's threads, the threads to skip, whether answers are allowed, and each thread's link. */
type Scan = {
	rpc: Conn;
	all: ShellThread[];
	skip: ReadonlySet<string>;
	canAnswer: boolean;
	link: (t: ShellThread) => string | undefined;
};

async function listWaitingOn(ctx: Ctx, o: ListWaitingOptions): Promise<MirrorCard[]> {
	const { d, s, ms } = ctx;
	const token = readToken(d.conf, s.tokenFile);
	// No token is a server that cannot be read, not one with nothing waiting: the page keeps its last cards and says so.
	if (!token) throw Error(`no ${s.tokenFile}`);
	const skip = new Set(o.skipThreads);
	const canAnswer = Boolean(readToken(d.conf, s.operateTokenFile));
	// Warm the thread links: the environment read runs beside this listing and never delays it.
	void d.linker?.ready();
	try {
		const rpc = await ctx.open(token);
		try {
			const all = await snapshot(rpc as Rpc, ms);
			// The page's own link prefix wins; else the server's own link. Never waited for: until the server's environment is known
			// (read in the background, started below and by the first link asked for) a card has no link.
			const link = (t: ShellThread) => (o.linkBase ? `${o.linkBase}${t.id}` : d.linker?.links(t.id)?.ref);
			const scan: Scan = { rpc, all, skip, canAnswer, link };
			const cards = await questionCardsOf(ctx, scan);
			cards.push(...(await goalCardsOf(ctx, scan)));
			return cards;
		} finally {
			rpc.ws.close();
		}
	} catch (e) {
		throw Error(redact(String(e instanceof Error ? e.message : e), ctx.secrets()).slice(0, 200));
	}
}

/** The cards of every thread that has a pending request: its projection is read and its waiting items listed. */
async function questionCardsOf(ctx: Ctx, scan: Scan): Promise<MirrorCard[]> {
	const threads = scan.all.filter((t) => t.pendingRuntimeRequest?.id && !t.archivedAt && !scan.skip.has(t.id));
	const cards: MirrorCard[] = [];
	for (const t of threads) {
		const p = await ctx.project(scan.rpc, t.id);
		cards.push(...cardsFrom(ctx.s.name, scan.canAnswer, t, p.turnItems, scan.link(t), p.runs));
	}
	return cards;
}

/** Pure: whether a thread is scanned for a goal proposal: idle, unsettled and unarchived, not skipped, nothing pending. */
const goalCandidate = (t: ShellThread, skip: ReadonlySet<string>): boolean =>
	!(
		t.archivedAt ||
		skip.has(t.id) ||
		t.pendingRuntimeRequest?.id ||
		BUSY.has(String(t.status ?? "")) ||
		(t.settledAt && !t.unsettledAt)
	);

/** Goal proposals: idle, unsettled, unarchived threads changed in the last week. */
async function goalCardsOf(ctx: Ctx, scan: Scan): Promise<MirrorCard[]> {
	const { s, goalSeen } = ctx;
	const budget = { reads: 0 };
	const now = Date.now();
	const eligible = new Set<string>();
	const cards: MirrorCard[] = [];
	for (const t of scan.all) {
		if (!goalCandidate(t, scan.skip)) continue;
		const at = String(t.updatedAt ?? "");
		if (!at || now - Date.parse(at) > GOAL_WINDOW_MS) continue;
		const key = `${s.name}\0${t.id}`;
		eligible.add(key);
		const seen = await goalSeenFor(ctx, scan.rpc, key, t.id, at, budget);
		if (seen?.proposal) cards.push(goalCard(s.name, scan.canAnswer, t, seen.proposal, scan.link(t)));
	}
	// Forget threads that left the scan (busy, settled, archived, aged out or gone), so the cache stays bounded.
	for (const key of goalSeen.keys()) if (key.startsWith(`${s.name}\0`) && !eligible.has(key)) goalSeen.delete(key);
	return cards;
}

/** A thread's goal proposal as last read: the cached read when its `updatedAt` is unchanged, else a fresh one, while the poll's read budget lasts (then none). */
async function goalSeenFor(
	ctx: Ctx,
	rpc: Conn,
	key: string,
	threadId: string,
	at: string,
	budget: { reads: number },
): Promise<GoalSeen | undefined> {
	const seen = ctx.goalSeen.get(key);
	if (seen && seen.updatedAt === at) return seen;
	if (budget.reads >= GOAL_READS_PER_POLL) return undefined;
	budget.reads++;
	const p = await ctx.project(rpc, threadId);
	const fresh = { updatedAt: at, proposal: goalProposal(p.turnItems) };
	ctx.goalSeen.set(key, fresh);
	return fresh;
}

/** What one answer attempt did, for the outcome it reports when the call fails: whether a command went out, and whether T3 refused it. */
type Attempt = { dispatched: boolean; refusedByT3: boolean };
/** One answer in flight: the card and the choice, the open socket and what the attempt has done. */
type AnswerJob = { ctx: Ctx; rpc: Conn; attempt: Attempt; card: MirrorCard; choice: number; sig: string; key: string };

const stale = (error: string, gone = false): AnswerOutcome => ({
	ok: false,
	kind: "stale",
	error,
	maybeSent: false,
	...(gone ? { gone } : {}),
});

/** If its reply is lost, the answer may still have delivered. T3 refusing the command (an "rpc failure" reply) means it did not. */
function dispatch(job: AnswerJob, cmd: Record<string, unknown>, what: string) {
	job.attempt.dispatched = true;
	return within(job.rpc.request("orchestration.dispatchCommand", cmd), job.ctx.ms, what).catch((e) => {
		if (String(e).includes("rpc failure")) job.attempt.refusedByT3 = true;
		throw e;
	});
}

/**
 * Answers a card with one of its options, after re-reading it from its thread: it must still be the same waiting
 * card, unchanged since the operator saw it (`sig`), and the server must have an operate token. The core has already
 * checked the choice is an option and the fingerprint is the one it listed. Nothing but a question, an approval or
 * a goal is ever answered here.
 */
async function answerOn(ctx: Ctx, card: MirrorCard, choice: number, sig: string): Promise<AnswerOutcome> {
	const { d, s } = ctx;
	const token = readToken(d.conf, s.operateTokenFile);
	if (!token)
		return { ok: false, kind: "refused", error: `answer it in its thread on ${card.server}`, maybeSent: false };
	const attempt: Attempt = { dispatched: false, refusedByT3: false };
	try {
		const rpc = await ctx.open(token);
		try {
			return await answerThrough({ ctx, rpc, attempt, card, choice, sig, key: `${card.id}\0${sig}` });
		} finally {
			rpc.ws.close();
		}
	} catch (e) {
		const error = redact(String(e), ctx.secrets()).slice(0, 200);
		d.log("mirror-answer-error", { id: card.id, server: card.server, error });
		return {
			ok: false,
			kind: "unreachable",
			error: `could not reach T3: ${error}`,
			maybeSent: attempt.dispatched && !attempt.refusedByT3,
		};
	}
}

/** The answer over an open socket: the card is read again from its thread, and the kind of card says how it is answered. */
async function answerThrough(job: AnswerJob): Promise<AnswerOutcome> {
	const { ctx, rpc, card } = job;
	const p = await ctx.project(rpc, card.threadId);
	if (card.type === "goal") return answerGoal(job, p);
	const live = (p.turnItems ?? []).find((i) => String(i.requestId ?? "") === card.requestId);
	const want = card.type === "approval" ? "approval_request" : "user_input_request";
	if (!live || live.type !== want || live.status !== "waiting")
		return stale("that card was already answered or withdrawn in its thread", true);
	return card.type === "approval" ? answerApproval(job, live) : answerQuestion(job, live);
}

async function answerGoal(job: AnswerJob, p: Projected): Promise<AnswerOutcome> {
	const { ctx, card, sig, key } = job;
	// Still the same proposal, still the last word in the thread, and nothing running: then send the /goal.
	const live = goalProposal(p.turnItems ?? []);
	const busy = (p.runs ?? []).some((r) => BUSY.has(String(r.status ?? "")));
	if (!live) return stale("that goal was already answered in its thread", true);
	const now = goalCard(card.server, true, { id: card.threadId, title: card.threadTitle }, live);
	if (busy || now.sig !== sig || now.sig !== card.sig)
		return stale("the goal changed since you saw it, or the thread is busy: refresh and try again");
	await dispatch(
		job,
		messageCommand({ threadId: card.threadId, text: live.goal, seed: key, identity: "operator", start: true }),
		"send",
	);
	ctx.d.log("mirror-goal-accepted", {
		id: card.id,
		server: card.server,
		threadId: card.threadId,
		threadTitle: card.threadTitle,
		goal: live.goal,
	});
	return { ok: true, choice: "Goal accepted" };
}

async function answerApproval(job: AnswerJob, live: TurnItem): Promise<AnswerOutcome> {
	const { ctx, card, choice, sig, key } = job;
	// Byte-for-byte: the live approval must give the fingerprint the principal was shown.
	const now = approvalCard(card.server, true, { id: card.threadId, title: card.threadTitle }, live);
	if (!now?.answerable || now.sig !== sig || now.sig !== card.sig)
		return stale("the approval changed since you saw it: refresh and answer again");
	const decision = APPROVAL_DECISIONS[choice];
	if (decision === undefined) throw Error(`approval choice ${choice} is not one of ${APPROVAL_DECISIONS.join(", ")}`);
	await dispatch(
		job,
		{
			type: "runtime-request.respond",
			commandId: stableId(`cmd\0${key}`),
			threadId: card.threadId,
			requestId: card.requestId,
			decision,
		},
		"respond",
	);
	ctx.d.log("mirror-approval-answered", {
		id: card.id,
		server: card.server,
		threadId: card.threadId,
		threadTitle: card.threadTitle,
		requestId: card.requestId,
		decision,
		requestKind: live.requestKind ?? null,
		command: live.prompt ?? null,
		reason: live.reason ?? null,
	});
	return { ok: true, choice: decision === "accept" ? "Approved once" : "Declined" };
}

async function answerQuestion(job: AnswerJob, live: TurnItem): Promise<AnswerOutcome> {
	const { ctx, card, choice, sig, key } = job;
	// The live card must be exactly the one the principal saw: same questions, same options in the same order, still untagged.
	const now = cardsFrom(card.server, true, { id: card.threadId, title: card.threadTitle }, [live])[0];
	const q = live.questions?.[0];
	const raw = q?.options?.[choice]?.label;
	const picked = now?.options[choice];
	if (!now?.answerable || now.sig !== sig || !q || raw === undefined || !picked)
		return stale("the card changed since you saw it: refresh and answer again");
	await dispatch(
		job,
		{
			type: "runtime-request.respond",
			commandId: stableId(`cmd\0${key}`),
			threadId: card.threadId,
			requestId: card.requestId,
			answers: { [q.id]: raw },
		},
		"respond",
	);
	ctx.d.log("mirror-answered", {
		id: card.id,
		server: card.server,
		threadId: card.threadId,
		requestId: card.requestId,
		choice: picked.label,
	});
	return { ok: true, choice: picked.label };
}
