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
import { readFileSync, statSync } from "node:fs";
import { isPrivateFile } from "../../core/private.ts";
import { connect, type Rpc } from "./rpc.ts";
import { OPERATOR_ONLY_KINDS } from "../../core/decide.ts";
import { normalizeWaitKind } from "./state.ts";
import { tagIn } from "../../core/questions.ts";
import type { AnswerOutcome, ListWaitingOptions, WaitingCard } from "../../core/adapter.ts";
import type { T3Server } from "./server.ts";

export type Server = Pick<T3Server, "name" | "origin" | "tokenFile" | "operateTokenFile">;
type Question = { id: string; header?: string; question?: string; multiSelect?: boolean; options?: { label: string; description?: string }[] };
type TurnItem = { type: string; status: string; requestId?: string; id?: string; messageId?: string | null; text?: string; questions?: Question[]; prompt?: string; reason?: string; label?: string; url?: string; appName?: string; requestKind?: string; fullAccessOverride?: unknown; options?: unknown };
/** A thread in the shell snapshot (field names as T3 sends them; see toState in src/core/decide.ts). */
type ShellThread = { id: string; title?: string; pendingRuntimeRequest?: { id?: string } | null; archivedAt?: string | null; status?: string; updatedAt?: string; settledAt?: string | null; unsettledAt?: string | null };

export type MirrorCard = WaitingCard;

export const MIRROR_ID = /^C-[a-f0-9]{12}$/;
export const mirrorId = (server: string, requestId: string) => `C-${createHash("sha256").update(`${server}\0${requestId}`).digest("hex").slice(0, 12)}`;
const RECOMMENDED = /\s*\(Recommended[^)]*\)\s*$/i;
/** Pure: a fingerprint of everything the card asks (ids, text, options in order, multiSelect). */
export const cardSig = (questions: unknown) => createHash("sha256").update(JSON.stringify(questions ?? null)).digest("hex").slice(0, 16);
/** Pure: the message with every secret in it replaced, for logs and error bodies. */
export const redact = (msg: string, secrets: (string | undefined)[]) => secrets.reduce<string>((m, s) => (s ? m.split(s).join("[redacted]") : m), msg);

/** Pure: the question cards in one thread's turn items, as queue entries. Everything else waiting is left out. */
export function cardsFrom(server: string, canAnswer: boolean, thread: ShellThread, items: TurnItem[], link?: string): MirrorCard[] {
	const out: MirrorCard[] = [];
	for (const i of items) {
		if (i.status !== "waiting") continue;
		const kind = normalizeWaitKind(String(i.type));
		if (i.type === "approval_request") { const r = approvalCard(server, canAnswer, thread, i, link); if (r) out.push(r); continue; }
		if (OPERATOR_ONLY_KINDS.has(kind)) { const r = readOnly(server, thread, i, kind, link); if (r) out.push(r); continue; }
		if (i.type !== "user_input_request") continue;
		const requestId = String(i.requestId ?? "");
		const qs = i.questions ?? [];
		if (!requestId || !qs.length) continue;
		if (qs.some((q) => tagIn(`${q.id} ${q.header ?? ""} ${q.question ?? ""}`))) continue;
		const q = qs[0]!;
		const options = (q.options ?? []).map((o) => ({ label: o.label.replace(RECOMMENDED, "").trim(), ...(o.description && o.description !== o.label ? { detail: o.description } : {}) }));
		const rec = (q.options ?? []).findIndex((o) => RECOMMENDED.test(o.label));
		const why = !canAnswer ? `answer it in its thread on ${server}`
			: qs.length > 1 ? "it asks several questions: answer it in its thread"
			: q.multiSelect ? "it allows several choices: answer it in its thread"
			: !options.length ? "it wants a written answer: answer it in its thread"
			: undefined;
		out.push({
			id: mirrorId(server, requestId), type: "question", server, threadId: thread.id, threadTitle: thread.title ?? "(untitled thread)", requestId,
			...(q.header ? { header: q.header } : {}), question: q.question ?? q.header ?? "", options,
			...(rec >= 0 ? { recommended: rec } : {}), answerable: !why, ...(why ? { why } : {}), ...(link ? { link } : {}), sig: cardSig(qs),
		});
	}
	return out;
}

const one = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** The only decisions the page can send for an approval, by option index. Never "always" or "for this session". */
export const APPROVAL_DECISIONS = ["accept", "decline"] as const;

/**
 * Pure: an approval as a queue entry. Answerable only with an operate token and a non-empty command. Its fingerprint
 * covers every field T3 shows for it, so any change, even one byte of the command, refuses an answer given to the old one.
 */
function approvalCard(server: string, canAnswer: boolean, thread: ShellThread, i: TurnItem, link?: string): MirrorCard | undefined {
	const requestId = String(i.requestId ?? "");
	if (!requestId) return undefined;
	const command = typeof i.prompt === "string" ? i.prompt : "";
	const why = !canAnswer ? `approve or decline it in its thread on ${server}` : !command.trim() ? "it shows no command: approve or decline it in its thread" : undefined;
	const sig = cardSig({ type: i.type, requestId, requestKind: i.requestKind ?? null, prompt: i.prompt ?? null, reason: i.reason ?? null, appName: i.appName ?? null, fullAccessOverride: i.fullAccessOverride ?? null, options: i.options ?? null });
	return {
		id: mirrorId(server, requestId), type: "approval", server, threadId: thread.id, threadTitle: thread.title ?? "(untitled thread)", requestId,
		header: "Approval", question: [one(i.requestKind), one(i.reason), i.appName ? `(${one(i.appName)})` : ""].filter(Boolean).join(" · ") || "Approval",
		command, options: why ? [] : [{ label: "Approve once" }, { label: "Decline" }], answerable: !why, ...(why ? { why } : {}), ...(link ? { link } : {}), sig,
	};
}

/** Pure: a secret or link request as a read-only entry. Never answerable; a secret's value is never asked for. */
function readOnly(server: string, thread: ShellThread, i: TurnItem, kind: string, link?: string): MirrorCard | undefined {
	const requestId = String(i.requestId ?? i.id ?? "");
	if (!requestId) return undefined;
	const [type, header, question, why] =
		kind === "secret_request" ? ["secret", "Secret request", [one(i.label), one(i.reason)].filter(Boolean).join(" · "), "enter it in its thread; secrets are never entered here"]
		: ["link", "Link request", [one(i.label) || one(i.url) || "link two T3 machines", one(i.reason)].filter(Boolean).join(" · "), "approve it in its thread"];
	return {
		id: mirrorId(server, requestId), type: type as MirrorCard["type"], server, threadId: thread.id, threadTitle: thread.title ?? "(untitled thread)", requestId,
		header, question: question || header, options: [], answerable: false, why, ...(link ? { link } : {}), sig: cardSig([kind, requestId]),
	};
}

const readToken = (conf: string, file: string | null | undefined): string | undefined => {
	if (!file) return undefined;
	try {
		const p = `${conf}/${file}`;
		if (!isPrivateFile(statSync(p))) return undefined;
		return readFileSync(p, "utf8").trim() || undefined;
	} catch {
		// EMPTY_CATCH_OK: no token file means that server is read-only (or unread); the caller logs the outcome.
		return undefined;
	}
};

/** The first shell snapshot of a server: every thread with its waiting request, if any. */
async function snapshot(rpc: Rpc, timeoutMs = 10_000): Promise<ShellThread[]> {
	return await new Promise<ShellThread[]>((resolve, reject) => {
		const timer = setTimeout(() => reject(Error("snapshot timed out")), timeoutMs);
		rpc.call("orchestration.subscribeShell", {}, (v) => {
			if (v?.kind === "snapshot" && v.snapshot) { clearTimeout(timer); resolve((v.snapshot.threads ?? []) as ShellThread[]); }
		}).catch((e) => { clearTimeout(timer); reject(e); });
	});
}

/** Pure: the /goal text a thread is waiting on the principal to accept, if its last message proposes one. */
export function goalProposal(items: TurnItem[]): { messageId: string; goal: string } | undefined {
	const msgs = items.filter((i) => i.type === "assistant_message" || i.type === "user_message");
	const last = msgs.at(-1);
	if (!last || last.type !== "assistant_message" || last.status !== "completed" || typeof last.text !== "string") return undefined;
	const blocks = [...last.text.matchAll(/```[a-z]*\n(\/goal [\s\S]*?)\n```/g)].map((m) => m[1]!.trim());
	const goal = blocks.at(-1);
	const messageId = String(last.messageId ?? last.id ?? "");
	return goal && messageId ? { messageId, goal } : undefined;
}

const BUSY = new Set(["running", "starting", "preparing", "queued", "waiting"]);

/** Pure: a goal proposal as a queue entry. Accepting sends the exact /goal text; it needs an operate token. */
export function goalCard(server: string, canAnswer: boolean, thread: ShellThread, p: { messageId: string; goal: string }, link?: string): MirrorCard {
	const why = canAnswer ? undefined : `accept it in its thread on ${server}`;
	return {
		id: mirrorId(server, `goal:${p.messageId}`), type: "goal", server, threadId: thread.id, threadTitle: thread.title ?? "(untitled thread)", requestId: `goal:${p.messageId}`,
		header: "Goal proposal", question: one(p.goal.split("\n")[0]!.replace(/^\/goal\s+/, "")), command: p.goal,
		options: why ? [] : [{ label: "Accept goal" }], answerable: !why, ...(why ? { why } : {}), ...(link ? { link } : {}),
		sig: cardSig({ kind: "goal", messageId: p.messageId, goal: p.goal }),
	};
}

/** Pure: a UUID-shaped ID fixed by its seed, so a retried send carries the same command and message IDs. */
export const stableId = (seed: string) => {
	const h = createHash("sha256").update(seed).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** A call that hasn't answered by then fails, so one hung server can't stall the poll. */
export const CALL_TIMEOUT_MS = 10_000;
export function within<T>(p: Promise<T>, ms = CALL_TIMEOUT_MS, what = "T3 call"): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(`${what} timed out after ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
}


export type WaitingDeps = {
	server: Server;
	conf: string;
	log: (event: string, data?: Record<string, unknown>) => void;
	connect?: (origin: string, token: string) => Promise<Pick<Rpc, "request" | "call"> & { ws: { close(): void } }>;
	/** Per-call deadline; tests shorten it. */
	timeoutMs?: number;
};

/**
 * One T3 server's waiting cards: `listWaiting` reads them (and throws, with every token redacted, when the server can't
 * be read), `answer` answers one after re-reading it live, and `send` sends a message into a thread as the Steward.
 */
export function createT3Waiting(d: WaitingDeps) {
	const open = connect as unknown as NonNullable<WaitingDeps["connect"]>;
	const conn = d.connect ?? open;
	const s = d.server;
	const ms = d.timeoutMs ?? CALL_TIMEOUT_MS;
	const secrets = () => [readToken(d.conf, s.tokenFile), readToken(d.conf, s.operateTokenFile)];
	/** server\0threadId -> the updatedAt last read and the proposal found then, so an unchanged thread isn't re-read. */
	const goalSeen = new Map<string, { updatedAt: string; proposal?: { messageId: string; goal: string } }>();
	const GOAL_WINDOW_MS = 7 * 24 * 3600_000;
	const GOAL_READS_PER_POLL = 40;
	const project = (rpc: { request: Rpc["request"] }, threadId: string) => within(rpc.request("orchestration.getThreadProjection", { threadId }), ms, "projection read") as Promise<{ turnItems?: TurnItem[]; runs?: { status?: string }[] }>;
	/** Opens a connection with a deadline. One that arrives after it is closed at once, so no socket or timer lingers. */
	const open_ = (token: string) => {
		let late = false;
		const p = conn(s.origin, token);
		p.then((rpc) => { if (late) rpc.ws.close(); }, () => {});
		return within(p, ms, "connect").catch((e) => { late = true; throw e; });
	};

	async function listWaiting(o: ListWaitingOptions): Promise<MirrorCard[]> {
		const token = readToken(d.conf, s.tokenFile);
		if (!token) return [];
		const skip = new Set(o.skipThreads);
		const canAnswer = Boolean(readToken(d.conf, s.operateTokenFile));
		try {
			const rpc = await open_(token);
			try {
				const all = await snapshot(rpc as Rpc, ms);
				const link = (t: ShellThread) => (o.linkBase ? `${o.linkBase}${t.id}` : undefined);
				const threads = all.filter((t) => t.pendingRuntimeRequest?.id && !t.archivedAt && !skip.has(t.id));
				const cards: MirrorCard[] = [];
				for (const t of threads) {
					const p = await project(rpc, t.id);
					cards.push(...cardsFrom(s.name, canAnswer, t, p.turnItems ?? [], link(t)));
				}
				// Goal proposals: idle, unsettled, unarchived threads changed in the last week.
				let reads = 0;
				const now = Date.now();
				const eligible = new Set<string>();
				for (const t of all) {
					if (t.archivedAt || skip.has(t.id) || t.pendingRuntimeRequest?.id || BUSY.has(String(t.status ?? "")) || (t.settledAt && !t.unsettledAt)) continue;
					const at = String(t.updatedAt ?? "");
					if (!at || now - Date.parse(at) > GOAL_WINDOW_MS) continue;
					const key = `${s.name}\0${t.id}`;
					eligible.add(key);
					let seen = goalSeen.get(key);
					if (!seen || seen.updatedAt !== at) {
						if (reads >= GOAL_READS_PER_POLL) continue;
						reads++;
						const p = await project(rpc, t.id);
						seen = { updatedAt: at, proposal: goalProposal(p.turnItems ?? []) };
						goalSeen.set(key, seen);
					}
					if (seen.proposal) cards.push(goalCard(s.name, canAnswer, t, seen.proposal, link(t)));
				}
				// Forget threads that left the scan (busy, settled, archived, aged out or gone), so the cache stays bounded.
				for (const key of goalSeen.keys()) if (key.startsWith(`${s.name}\0`) && !eligible.has(key)) goalSeen.delete(key);
				return cards;
			} finally {
				rpc.ws.close();
			}
		} catch (e) {
			throw Error(redact(String(e instanceof Error ? e.message : e), secrets()).slice(0, 200));
		}
	}

	/**
	 * Answers a card with one of its options, after re-reading it from its thread: it must still be the same waiting
	 * card, unchanged since the operator saw it (`sig`), and the server must have an operate token. The core has already
	 * checked the choice is an option and the fingerprint is the one it listed. Nothing but a question, an approval or
	 * a goal is ever answered here.
	 */
	async function answer(card: MirrorCard, choice: number, sig: string): Promise<AnswerOutcome> {
		const token = readToken(d.conf, s.operateTokenFile);
		if (!token) return { ok: false, kind: "refused", error: `answer it in its thread on ${card.server}`, maybeSent: false };
		const key = `${card.id}\0${sig}`;
		let dispatched = false;
		let refusedByT3 = false;
		const ids = { commandId: stableId(`cmd\0${key}`), messageId: stableId(`msg\0${key}`) };
		/** If its reply is lost, the answer may still have delivered. T3 refusing the command (an "rpc failure" reply) means it did not. */
		const dispatch = (cmd: Record<string, unknown>, what: string) => {
			dispatched = true;
			return within(rpc.request("orchestration.dispatchCommand", cmd), ms, what).catch((e) => { if (String(e).includes("rpc failure")) refusedByT3 = true; throw e; });
		};
		const stale = (error: string, gone = false): AnswerOutcome => ({ ok: false, kind: "stale", error, maybeSent: false, ...(gone ? { gone } : {}) });
		let rpc!: Awaited<ReturnType<typeof open_>>;
		try {
			rpc = await open_(token);
			try {
				const p = await project(rpc, card.threadId);
				if (card.type === "goal") {
					// Still the same proposal, still the last word in the thread, and nothing running: then send the /goal.
					const live = goalProposal(p.turnItems ?? []);
					const busy = (p.runs ?? []).some((r) => BUSY.has(String(r.status ?? "")));
					if (!live) return stale("that goal was already answered in its thread", true);
					const now = goalCard(card.server, true, { id: card.threadId, title: card.threadTitle }, live);
					if (busy || now.sig !== sig || now.sig !== card.sig) return stale("the goal changed since you saw it, or the thread is busy: refresh and try again");
					await dispatch({ type: "message.dispatch", commandId: ids.commandId, threadId: card.threadId, messageId: ids.messageId, text: live.goal, attachments: [], createdBy: "user", creationSource: "server", dispatchMode: { type: "start_immediately" } }, "send");
					d.log("mirror-goal-accepted", { id: card.id, server: card.server, threadId: card.threadId, threadTitle: card.threadTitle, goal: live.goal });
					return { ok: true, choice: "Goal accepted" };
				}
				const live = (p.turnItems ?? []).find((i) => String(i.requestId ?? "") === card.requestId);
				const want = card.type === "approval" ? "approval_request" : "user_input_request";
				if (!live || live.type !== want || live.status !== "waiting") return stale("that card was already answered or withdrawn in its thread", true);
				if (card.type === "approval") {
					// Byte-for-byte: the live approval must give the fingerprint the principal was shown.
					const now = approvalCard(card.server, true, { id: card.threadId, title: card.threadTitle }, live);
					if (!now || !now.answerable || now.sig !== sig || now.sig !== card.sig) return stale("the approval changed since you saw it: refresh and answer again");
					const decision = APPROVAL_DECISIONS[choice]!;
					await dispatch({ type: "runtime-request.respond", commandId: ids.commandId, threadId: card.threadId, requestId: card.requestId, decision }, "respond");
					d.log("mirror-approval-answered", { id: card.id, server: card.server, threadId: card.threadId, threadTitle: card.threadTitle, requestId: card.requestId, decision, requestKind: live.requestKind ?? null, command: live.prompt ?? null, reason: live.reason ?? null });
					return { ok: true, choice: decision === "accept" ? "Approved once" : "Declined" };
				}
				// The live card must be exactly the one the principal saw: same questions, same options in the same order, still untagged.
				const now = cardsFrom(card.server, true, { id: card.threadId, title: card.threadTitle }, [live])[0];
				const q = live.questions?.[0];
				const raw = q?.options?.[choice]?.label;
				if (!now || !now.answerable || now.sig !== sig || !q || raw === undefined) return stale("the card changed since you saw it: refresh and answer again");
				await dispatch({ type: "runtime-request.respond", commandId: ids.commandId, threadId: card.threadId, requestId: card.requestId, answers: { [q.id]: raw } }, "respond");
				const label = now.options[choice]!.label;
				d.log("mirror-answered", { id: card.id, server: card.server, threadId: card.threadId, requestId: card.requestId, choice: label });
				return { ok: true, choice: label };
			} finally {
				rpc.ws.close();
			}
		} catch (e) {
			const error = redact(String(e), secrets()).slice(0, 200);
			d.log("mirror-answer-error", { id: card.id, server: card.server, error });
			return { ok: false, kind: "unreachable", error: `could not reach T3: ${error}`, maybeSent: dispatched && !refusedByT3 };
		}
	}

	/**
	 * Sends one message into a thread as the Steward: T3's `message.dispatch` over the server's RPC with its operate token,
	 * the command `answer` sends a goal with and `t3x send` uses. Like `t3x send`, it steers a run that is going, or starts
	 * one, and it is signed as the Steward's (agent, mcp), so the thread's report-back wakes the Steward as a hand relay
	 * would. `seed` fixes its command and message IDs, so T3 can drop a repeat of the same send.
	 */
	async function send(threadId: string, text: string, seed: string): Promise<{ ok: boolean; detail: string }> {
		const token = readToken(d.conf, s.operateTokenFile);
		if (!token) return { ok: false, detail: `${s.name} has no operate token here, so the page can't send to its threads` };
		try {
			const rpc = await open_(token);
			try {
				const proj = await within(rpc.request("orchestration.getThreadProjection", { threadId }), ms, "projection read") as { runs?: { id?: string; status?: string }[] };
				const active = [...(proj.runs ?? [])].reverse().find((r) => ["running", "waiting", "starting"].includes(String(r.status)))?.id;
				await within(rpc.request("orchestration.dispatchCommand", {
					type: "message.dispatch", commandId: stableId(`cmd\0${seed}`), threadId, messageId: stableId(`msg\0${seed}`), text, attachments: [],
					createdBy: "agent", creationSource: "mcp", dispatchMode: active ? { type: "steer_active", targetRunId: active } : { type: "start_immediately" },
				}), ms, "send");
				return { ok: true, detail: `sent to ${s.name}:${threadId}` };
			} finally {
				rpc.ws.close();
			}
		} catch (e) {
			return { ok: false, detail: redact(String(e), [token]).slice(0, 200) };
		}
	}

	return { listWaiting, answer, send };
}
