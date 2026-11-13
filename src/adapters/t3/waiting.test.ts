/**
 * The T3 side of the waiting-card mirror, driven through the page's aggregator (src/web/waiting.ts) the way the page uses
 * it: it shows question cards only, answers only where web.json grants a token, and drops a card answered in its thread.
 */
import { memStore } from "../../testing/store.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Adapter } from "../../core/adapter.ts";
import { createWaiting, threadSender, withAnswerRights } from "../../web/waiting.ts";
import { cardsFrom, createT3Waiting, goalProposal, mirrorId, redact, type Server, type WaitingDeps } from "./waiting.ts";

/** The page's mirror over T3 servers: one T3 reader per server (kept between polls, as the adapter keeps its own), listed and answered through the aggregator. */
type MirrorDeps = Pick<WaitingDeps, "conf" | "log" | "connect" | "timeoutMs"> & { servers: () => Server[]; skipThreads: () => string[]; links?: Record<string, string> };
function adapters(d: MirrorDeps) {
	const readers = new Map<string, ReturnType<typeof createT3Waiting>>();
	const pairs = () => d.servers().map((server) => {
		const key = `${server.name}\0${server.operateTokenFile}`;
		let w = readers.get(key);
		if (!w) { w = createT3Waiting({ server, conf: d.conf, log: d.log, connect: d.connect, timeoutMs: d.timeoutMs }); readers.set(key, w); }
		return { server: server as never, adapter: { id: "t3", capabilities: ["listWaiting", "answer", "send"], listWaiting: w.listWaiting, answer: w.answer, send: w.send } as unknown as Adapter };
	});
	return pairs;
}
const createMirror = (d: MirrorDeps) => createWaiting({ store: memStore(), servers: adapters(d), skipThreads: d.skipThreads, links: d.links, log: d.log });
const threadSenderFor = (d: MirrorDeps) => threadSender(adapters(d));

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const question = (requestId: string, over: Record<string, unknown> = {}) => ({
	type: "user_input_request", status: "waiting", requestId,
	questions: [{ id: "0", header: "Pick", question: "Approve one more round?", options: [{ label: "Approve (Recommended)", description: "Approve (Recommended)" }, { label: "Hold", description: "keep it held" }] }],
	...over,
});
const T = { id: "th-1", title: "Code improvements", pendingRuntimeRequest: { id: "r1" } };

test("question cards and approvals are answerable; secrets and links are listed read-only; done or queue-tagged cards are left out", () => {
	const items = [
		question("r1"),
		{ type: "approval_request", status: "waiting", requestId: "r2", requestKind: "command", prompt: "rm -rf build", reason: "clean" },
		{ type: "secret_request", status: "waiting", requestId: "r3", label: "API key", reason: "deploy", placeholder: "sk-…" },
		{ type: "link_request", status: "waiting", requestId: "r4", url: "http://vps:3773", reason: "link the vps" },
		{ type: "approval_request", status: "completed", requestId: "r7" },
		question("r5", { status: "completed" }),
		question("r6", { questions: [{ id: "Steward [Q-abcd]", question: "x [Q-abcd]", options: [{ label: "A" }] }] }),
	];
	const cards = cardsFrom("main", true, T, items, "t3-thread://v2/env/th-1");
	expect(cards.map((c) => [c.requestId, c.type, c.answerable])).toEqual([["r1", "question", true], ["r2", "approval", true], ["r3", "secret", false], ["r4", "link", false]]);
	expect(cards[1]!.command).toBe("rm -rf build");
	expect(cards[1]!.question).toBe("command · clean");
	expect(cards[1]!.options.map((o) => o.label)).toEqual(["Approve once", "Decline"]);
	expect(cards[2]!.question).toBe("API key · deploy");
	expect(cards[3]!.question).toBe("http://vps:3773 · link the vps");
	for (const r of cards.slice(2)) { expect(r.options).toEqual([]); expect(r.link).toBe("t3-thread://v2/env/th-1"); expect(r.why).toBeTruthy(); }
	const c = cards[0]!;
	expect(c.id).toBe(mirrorId("main", "r1"));
	expect(c.options).toEqual([{ label: "Approve" }, { label: "Hold", detail: "keep it held" }]);
	expect(c.recommended).toBe(0);
	expect(c.answerable).toBe(true);
	expect(c.threadTitle).toBe("Code improvements");
});

test("a card is read-only without the token, or when it asks several things, allows several picks, or wants text", () => {
	expect(cardsFrom("laptop", false, T, [question("r1")])[0]!.why).toBe("answer it in its thread on laptop");
	const two = question("r1", { questions: [question("x").questions[0], { id: "1", question: "and?", options: [{ label: "A" }] }] });
	expect(cardsFrom("main", true, T, [two])[0]!.answerable).toBe(false);
	const multi = question("r1", { questions: [{ ...question("x").questions[0], multiSelect: true }] });
	expect(cardsFrom("main", true, T, [multi])[0]!.answerable).toBe(false);
	const text = question("r1", { questions: [{ id: "0", question: "Why?", options: [] }] });
	expect(cardsFrom("main", true, T, [text])[0]!.answerable).toBe(false);
});

function rig(opts: { operate?: boolean; items?: () => unknown[]; fail?: (token: string) => string | undefined } = {}) {
	const conf = mkdtempSync(`${tmpdir()}/chamberlain-mirror-`);
	dirs.push(conf);
	mkdirSync(conf, { recursive: true });
	for (const f of ["read-token", ...(opts.operate === false ? [] : ["op-token"])]) { writeFileSync(`${conf}/${f}`, `tok-${f}`); chmodSync(`${conf}/${f}`, 0o600); }
	let items = opts.items ?? (() => [question("r1")]);
	const sent: { tag: string; payload: any; token: string }[] = [];
	const logs: { e: string; data?: any }[] = [];
	const connect = async (_origin: string, token: string) => {
		const f = opts.fail?.(token);
		if (f) throw Error(f);
		return {
		ws: { close() {} },
		call: async (_tag: string, _payload: unknown, onChunk?: (v: any) => void) => { onChunk?.({ kind: "snapshot", snapshot: { threads: [T, { id: "skipme", pendingRuntimeRequest: { id: "q" } }, { id: "gone", pendingRuntimeRequest: { id: "z" }, archivedAt: "2026-11-10" }, { id: "idle" }] } }); },
		request: async (tag: string, payload: any) => {
			sent.push({ tag, payload, token });
			if (tag === "orchestration.getThreadProjection") return { turnItems: payload.threadId === "skipme" ? [question("rq")] : items() };
			return {};
		},
	};
	};
	const servers: Server[] = [{ name: "main", origin: "http://x", tokenFile: "read-token", operateTokenFile: "op-token" }];
	const m = createMirror({ conf, servers: () => servers, skipThreads: () => ["skipme"], log: (e, data) => logs.push({ e, data }), connect: connect as any });
	return { m, sent, logs, setItems: (f: () => unknown[]) => { items = f; } };
}

test("poll lists the card, skips the Questions/Decisions threads, and answers it through the operate token", async () => {
	const { m, sent } = rig();
	await m.poll();
	expect(m.list().map((c) => c.requestId)).toEqual(["r1"]);
	expect(sent.some((s) => s.payload?.threadId === "skipme" || s.payload?.threadId === "gone" || s.payload?.threadId === "idle")).toBe(false);
	const { id, sig } = m.list()[0]!;
	const r = await m.answer(id, 0, sig);
	expect(r.status).toBe(200);
	const respond = sent.find((s) => s.tag === "orchestration.dispatchCommand")!;
	expect(respond.token).toBe("tok-op-token");
	expect(respond.payload).toMatchObject({ type: "runtime-request.respond", threadId: "th-1", requestId: "r1", answers: { "0": "Approve (Recommended)" } });
	expect(m.list()).toHaveLength(0);
});

test("a card answered in its thread drops off at the next poll, and answering it from the page is refused", async () => {
	const { m, setItems, sent } = rig();
	await m.poll();
	const { id, sig } = m.list()[0]!;
	setItems(() => [question("r1", { status: "completed" })]);
	expect((await m.answer(id, 0, sig)).status).toBe(409);
	expect(sent.some((s) => s.tag === "orchestration.dispatchCommand")).toBe(false);
	await m.poll();
	expect(m.list()).toHaveLength(0);
});

test("a request that turned into something other than a question card is never answered", async () => {
	const { m, setItems, sent } = rig();
	await m.poll();
	const { id, sig } = m.list()[0]!;
	setItems(() => [{ type: "secret_request", status: "waiting", requestId: "r1" }]);
	expect((await m.answer(id, 0, sig)).status).toBe(409);
	expect(sent.some((s) => s.tag === "orchestration.dispatchCommand")).toBe(false);
});

test("without the operate token the card is listed read-only and can't be answered", async () => {
	const { m, sent } = rig({ operate: false });
	await m.poll();
	const c = m.list()[0]!;
	expect(c.answerable).toBe(false);
	expect((await m.answer(c.id, 0, c.sig)).status).toBe(403);
	expect(sent.some((s) => s.tag === "orchestration.dispatchCommand")).toBe(false);
});

test("a bad choice or unknown card is refused", async () => {
	const { m } = rig();
	await m.poll();
	const { id, sig } = m.list()[0]!;
	expect((await m.answer(id, 5, sig)).status).toBe(400);
	expect((await m.answer(id, "0", sig)).status).toBe(400);
	expect((await m.answer("C-000000000000", 0, sig)).status).toBe(404);
});

const swapped = (requestId: string, q: Record<string, unknown>) => question(requestId, { questions: [{ ...question("x").questions[0], ...q }] });

test("a question rewritten under the same request ID is refused, not answered", async () => {
	const { m, setItems, sent } = rig();
	await m.poll();
	const { id, sig } = m.list()[0]!;
	setItems(() => [swapped("r1", { id: "q2", question: "Delete the production database?" })]);
	expect((await m.answer(id, 0, sig)).status).toBe(409);
	expect(sent.some((s) => s.tag === "orchestration.dispatchCommand")).toBe(false);
});

test("options reversed after the view loaded are refused, both before and after the next poll", async () => {
	const { m, setItems, sent } = rig();
	await m.poll();
	const { id, sig } = m.list()[0]!;
	const reversed = () => [swapped("r1", { options: [{ label: "Hold", description: "keep it held" }, { label: "Approve (Recommended)", description: "Approve (Recommended)" }] })];
	setItems(reversed);
	expect((await m.answer(id, 0, sig)).status).toBe(409);
	await m.poll();
	expect((await m.answer(id, 0, sig)).status).toBe(409);
	expect(sent.some((s) => s.tag === "orchestration.dispatchCommand")).toBe(false);
	const fresh = m.list()[0]!;
	expect((await m.answer(fresh.id, 0, fresh.sig)).status).toBe(200);
	expect(sent.find((s) => s.tag === "orchestration.dispatchCommand")!.payload.answers).toEqual({ "0": "Hold" });
});

test("a queue tag added to the live card makes it unanswerable here", async () => {
	const { m, setItems, sent } = rig();
	await m.poll();
	const { id, sig } = m.list()[0]!;
	setItems(() => [swapped("r1", { question: "Approve one more round? [Q-abcd]" })]);
	expect((await m.answer(id, 0, sig)).status).toBe(409);
	expect(sent.some((s) => s.tag === "orchestration.dispatchCommand")).toBe(false);
});

test("an answer without the fingerprint it was shown is refused", async () => {
	const { m } = rig();
	await m.poll();
	const { id } = m.list()[0]!;
	expect((await m.answer(id, 0, undefined)).status).toBe(409);
	expect((await m.answer(id, 0, "0000")).status).toBe(409);
});

test("a token never reaches the log or an error body", async () => {
	const { m, logs } = rig({ fail: (token) => `upstream failure ${token}` });
	await m.poll();
	expect(JSON.stringify(logs)).not.toContain("tok-read-token");
	expect(JSON.stringify(logs)).toContain("[redacted]");
	let fail = false;
	const r2 = rig({ fail: (token) => (fail ? `boom ${token}` : undefined) });
	await r2.m.poll();
	const { id, sig } = r2.m.list()[0]!;
	fail = true;
	const res = await r2.m.answer(id, 0, sig);
	expect(res.status).toBe(502);
	expect(JSON.stringify(res.body)).not.toContain("tok-op-token");
	expect(JSON.stringify(r2.logs)).not.toContain("tok-op-token");
	expect(redact("a SECRET b SECRET", ["SECRET", undefined])).toBe("a [redacted] b [redacted]");
});

test("only the server at the decisions server's origin gets answer rights", () => {
	const qs = { origin: "http://127.0.0.1:3773", operateTokenFile: "op" };
	const out = withAnswerRights([
		{ name: "main", origin: "http://127.0.0.1:3773", tokenFile: "r" },
		{ name: "laptop", origin: "http://127.0.0.1:13774", tokenFile: "r", operateTokenFile: "laptop-op" },
		{ name: "main", origin: "http://evil:1", tokenFile: "r" },
	], qs);
	expect(out.map((s) => s.operateTokenFile as string | null)).toEqual(["op", null, null]);
	expect(withAnswerRights([{ name: "main", origin: "http://127.0.0.1:3773", tokenFile: "r" }]).map((s) => s.operateTokenFile as string | null)).toEqual([null]);
});

test("other servers can answer only when web.json's answerTokens names them", () => {
	const qs = { origin: "http://127.0.0.1:3773", operateTokenFile: "op" };
	const list: Server[] = [
		{ name: "main", origin: "http://127.0.0.1:3773", tokenFile: "r" },
		{ name: "laptop", origin: "http://127.0.0.1:13774", tokenFile: "r", operateTokenFile: "from-servers-json" },
		{ name: "remote", origin: "http://127.0.0.1:13773", tokenFile: "r" },
		{ name: "other", origin: "http://x:1", tokenFile: "r", operateTokenFile: "sneaky" },
	];
	expect(withAnswerRights(list, qs, { laptop: "laptop-operate-token", remote: "remote-operate-token" }).map((s) => s.operateTokenFile)).toEqual(["op", "laptop-operate-token", "remote-operate-token", null]);
	expect(withAnswerRights(list, qs, { main: "x" } as Record<string, string>).map((s) => s.operateTokenFile)).toEqual(["op", null, null, null]);
	expect(withAnswerRights(list, qs, JSON.parse('{"__proto__": "x", "constructor": "y"}')).map((s) => s.operateTokenFile)).toEqual(["op", null, null, null]);
});

test("a secret or link request listed here can never be answered from the page", async () => {
	const ro = [
		{ type: "secret_request", status: "waiting", requestId: "r3", label: "key", reason: "x" },
		{ type: "link_request", status: "waiting", requestId: "r4", reason: "x" },
		{ type: "secret_request", status: "waiting", id: "turn-item:secret-request:x", label: "key2", reason: "y" },
	];
	const { m, sent } = rig({ items: () => ro });
	await m.poll();
	expect(m.list()).toHaveLength(3);
	for (const c of m.list()) for (const choice of [0, 1]) expect((await m.answer(c.id, choice, c.sig)).status).toBe(403);
	expect(sent.some((s) => s.tag === "orchestration.dispatchCommand")).toBe(false);
});

const approval = (requestId: string, over: Record<string, unknown> = {}) => ({ type: "approval_request", status: "waiting", requestId, requestKind: "command", prompt: "true", reason: "harmless test", ...over });

test("an approval keeps its command byte for byte, and is read-only without the token or without a command", () => {
	const multi = "printf 'a  b'\n  && true";
	const c = cardsFrom("main", true, T, [approval("a1", { prompt: multi })])[0]!;
	expect(c.command).toBe(multi);
	expect(cardsFrom("laptop", false, T, [approval("a1")])[0]!.answerable).toBe(false);
	expect(cardsFrom("laptop", false, T, [approval("a1")])[0]!.options).toEqual([]);
	expect(cardsFrom("main", true, T, [approval("a1", { prompt: "  " })])[0]!.answerable).toBe(false);
	expect(cardsFrom("main", true, T, [approval("a1", { prompt: "true " })])[0]!.sig).not.toBe(c.sig);
});

test("approve once sends accept, decline sends decline, never anything wider, and the log has the full command", async () => {
	for (const [choice, decision] of [[0, "accept"], [1, "decline"]] as const) {
		const { m, sent, logs } = rig({ items: () => [approval("a1", { prompt: "true\n# second line" })] });
		await m.poll();
		const { id, sig } = m.list()[0]!;
		expect((await m.answer(id, choice, sig)).status).toBe(200);
		const respond = sent.find((s) => s.tag === "orchestration.dispatchCommand")!;
		expect(respond.payload).toMatchObject({ type: "runtime-request.respond", threadId: "th-1", requestId: "a1", decision });
		expect(respond.payload.answers).toBeUndefined();
		expect(respond.token).toBe("tok-op-token");
		const entry = logs.find((l) => l.e === "mirror-approval-answered")!;
		expect(entry.data).toMatchObject({ decision, command: "true\n# second line", reason: "harmless test", requestKind: "command" });
	}
	const { m } = rig({ items: () => [approval("a1")] });
	await m.poll();
	const { id, sig } = m.list()[0]!;
	expect((await m.answer(id, 2, sig)).status).toBe(400);
});

test("an approval whose command changed by one byte, or went stale, is refused", async () => {
	const { m, setItems, sent } = rig({ items: () => [approval("a1")] });
	await m.poll();
	const { id, sig } = m.list()[0]!;
	setItems(() => [approval("a1", { prompt: "true;" })]);
	expect((await m.answer(id, 0, sig)).status).toBe(409);
	setItems(() => [approval("a1", { status: "completed" })]);
	expect((await m.answer(id, 0, sig)).status).toBe(409);
	expect(sent.some((s) => s.tag === "orchestration.dispatchCommand")).toBe(false);
});

test("answering an approval can never answer a secret or link request, even under the same request ID", async () => {
	for (const swap of [
		{ type: "secret_request", status: "waiting", requestId: "a1", label: "key", reason: "x", prompt: "true" },
		{ type: "link_request", status: "waiting", requestId: "a1", reason: "x", prompt: "true" },
		{ type: "user_input_request", status: "waiting", requestId: "a1", prompt: "true", questions: [{ id: "0", question: "true", options: [{ label: "Approve once" }, { label: "Decline" }] }] },
	]) {
		const { m, setItems, sent } = rig({ items: () => [approval("a1")] });
		await m.poll();
		const { id, sig } = m.list()[0]!;
		setItems(() => [swap]);
		expect((await m.answer(id, 0, sig)).status).toBe(409);
		expect(sent.some((s) => s.tag === "orchestration.dispatchCommand")).toBe(false);
	}
});

test("an approval on a server without the operate token can't be answered", async () => {
	const { m, sent } = rig({ operate: false, items: () => [approval("a1")] });
	await m.poll();
	const c = m.list()[0]!;
	expect(c.answerable).toBe(false);
	expect((await m.answer(c.id, 0, c.sig)).status).toBe(403);
	expect(sent.some((s) => s.tag === "orchestration.dispatchCommand")).toBe(false);
});

// ---- goal proposals ----
const GOAL = "/goal Fix #7478 so the gate reads every body.\n\n## Done when\n1. `bun test` passes.";
const said = (text: string, over: Record<string, unknown> = {}) => ({ type: "assistant_message", status: "completed", messageId: "m1", text, ...over });
const proposalText = `I read the issue.\n\n🎯 Proposed goal\n\n\`\`\`markdown\n${GOAL}\n\`\`\`\n\nSay the word.`;

test("a goal proposal is the last message's fenced /goal block, with no reply after it", () => {
	expect(goalProposal([said(proposalText)])).toEqual({ messageId: "m1", goal: GOAL });
	expect(goalProposal([said(proposalText), { type: "user_message", status: "completed", text: "no" }])).toBeUndefined();
	expect(goalProposal([said(proposalText, { status: "running" })])).toBeUndefined();
	expect(goalProposal([said("```ts\nconst x = 1;\n```")])).toBeUndefined();
	expect(goalProposal([said(proposalText), { type: "command_execution", status: "completed" }])).toEqual({ messageId: "m1", goal: GOAL });
	const two = `\`\`\`markdown\n/goal old\n\`\`\`\nrevised:\n\`\`\`\n/goal new one\n\`\`\``;
	expect(goalProposal([said(two)])!.goal).toBe("/goal new one");
});

function goalRig(opts: { operate?: boolean; threads?: Record<string, unknown>[] } = {}) {
	const conf = mkdtempSync(`${tmpdir()}/chamberlain-goal-`);
	dirs.push(conf);
	for (const f of ["read-token", ...(opts.operate === false ? [] : ["op-token"])]) { writeFileSync(`${conf}/${f}`, `tok-${f}`); chmodSync(`${conf}/${f}`, 0o600); }
	const recent = new Date().toISOString();
	let threads = opts.threads ?? [{ id: "g1", title: "Fix #7478", status: "completed", updatedAt: recent }];
	let items: unknown[] = [said(proposalText)];
	let runs: unknown[] = [{ status: "completed" }];
	const sent: { tag: string; payload: any; token: string }[] = [];
	const connect = async (_o: string, token: string) => ({
		ws: { close() {} },
		call: async (_t: string, _p: unknown, onChunk?: (v: any) => void) => { onChunk?.({ kind: "snapshot", snapshot: { threads } }); },
		request: async (tag: string, payload: any) => { sent.push({ tag, payload, token }); return tag === "orchestration.getThreadProjection" ? { turnItems: items, runs } : {}; },
	});
	const servers: Server[] = [{ name: "main", origin: "http://x", tokenFile: "read-token", operateTokenFile: "op-token" }];
	const m = createMirror({ conf, servers: () => servers, skipThreads: () => [], log: () => {}, connect: connect as any });
	return { m, sent, set: (o: { items?: unknown[]; runs?: unknown[]; threads?: Record<string, unknown>[] }) => { if (o.items) items = o.items; if (o.runs) runs = o.runs; if (o.threads) threads = o.threads; } };
}

test("an idle thread proposing a goal is listed, and accepting sends the exact /goal text as his message", async () => {
	const { m, sent } = goalRig();
	await m.poll();
	const c = m.list()[0]!;
	expect([c.type, c.answerable, c.command, c.options.map((o) => o.label)]).toEqual(["goal", true, GOAL, ["Accept goal"]]);
	expect(c.question).toBe("Fix #7478 so the gate reads every body.");
	expect((await m.answer(c.id, 0, c.sig)).status).toBe(200);
	const d = sent.find((s) => s.tag === "orchestration.dispatchCommand")!;
	expect(d.payload).toMatchObject({ type: "message.dispatch", threadId: "g1", text: GOAL, createdBy: "user", creationSource: "server", dispatchMode: { type: "start_immediately" } });
	expect(d.token).toBe("tok-op-token");
	expect(m.list()).toHaveLength(0);
});

test("a busy, settled, archived or stale thread is not scanned, and an unchanged thread is not re-read", async () => {
	const old = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
	const now = new Date().toISOString();
	const { m, sent, set } = goalRig({ threads: [
		{ id: "busy", status: "running", updatedAt: now },
		{ id: "settled", status: "completed", updatedAt: now, settledAt: now },
		{ id: "arch", status: "completed", updatedAt: now, archivedAt: now },
		{ id: "stale", status: "completed", updatedAt: old },
		{ id: "ok", status: "completed", updatedAt: now },
	] });
	await m.poll();
	const reads = () => sent.filter((s) => s.tag === "orchestration.getThreadProjection").map((s) => s.payload.threadId);
	expect(reads()).toEqual(["ok"]);
	await m.poll();
	expect(reads()).toEqual(["ok"]);
	set({ threads: [{ id: "ok", status: "completed", updatedAt: new Date(Date.now() + 1000).toISOString() }] });
	await m.poll();
	expect(reads()).toEqual(["ok", "ok"]);
});

test("accepting is refused when the goal changed, he already replied, or a run started", async () => {
	for (const change of [
		{ items: [said(proposalText.replace("every body", "every bodY"))] },
		{ items: [said(proposalText), { type: "user_message", status: "completed", text: "go" }] },
		{ runs: [{ status: "running" }] },
	]) {
		const { m, sent, set } = goalRig();
		await m.poll();
		const c = m.list()[0]!;
		set(change);
		expect((await m.answer(c.id, 0, c.sig)).status).toBe(409);
		expect(sent.some((s) => s.tag === "orchestration.dispatchCommand")).toBe(false);
	}
});

test("a goal proposal can't be accepted without the operate token, or with a wrong choice or fingerprint", async () => {
	const ro = goalRig({ operate: false });
	await ro.m.poll();
	const c = ro.m.list()[0]!;
	expect(c.answerable).toBe(false);
	expect((await ro.m.answer(c.id, 0, c.sig)).status).toBe(403);
	const { m, sent } = goalRig();
	await m.poll();
	const g = m.list()[0]!;
	expect((await m.answer(g.id, 1, g.sig)).status).toBe(400);
	expect((await m.answer(g.id, 0, "nope")).status).toBe(409);
	expect(sent.some((s) => s.tag === "orchestration.dispatchCommand")).toBe(false);
});

test("prototype-named entries in answerTokens never grant rights", () => {
	const list: Server[] = [{ name: "__proto__", origin: "http://a", tokenFile: "r" }, { name: "constructor", origin: "http://b", tokenFile: "r" }, { name: "prototype", origin: "http://c", tokenFile: "r" }];
	const tokens = JSON.parse('{"__proto__": "op", "constructor": "op", "prototype": "op"}');
	expect(withAnswerRights(list, undefined, tokens).map((s) => s.operateTokenFile)).toEqual([null, null, null]);
});

test("a server that never answers a projection read can't stall the poll; the next server is still read", async () => {
	const conf = mkdtempSync(`${tmpdir()}/chamberlain-stall-`);
	dirs.push(conf);
	writeFileSync(`${conf}/read-token`, "tok"); chmodSync(`${conf}/read-token`, 0o600);
	const now = new Date().toISOString();
	const reads: string[] = [];
	const connect = async (origin: string) => ({
		ws: { close() {} },
		call: async (_t: string, _p: unknown, onChunk?: (v: any) => void) => { onChunk?.({ kind: "snapshot", snapshot: { threads: [{ id: `${origin}-t`, status: "completed", updatedAt: now }] } }); },
		request: (_tag: string, payload: any) => { reads.push(payload.threadId); return origin === "http://hang" ? new Promise(() => {}) : Promise.resolve({ turnItems: [said(proposalText)] }); },
	});
	const logs: string[] = [];
	const m = createMirror({ conf, servers: () => [{ name: "a", origin: "http://hang", tokenFile: "read-token" }, { name: "b", origin: "http://ok", tokenFile: "read-token" }], skipThreads: () => [], log: (e) => logs.push(e), connect: connect as any, timeoutMs: 30 });
	await m.poll();
	expect(reads).toEqual(["http://hang-t", "http://ok-t"]);
	expect(m.list().map((c) => c.server)).toEqual(["b"]);
	expect(logs).toContain("mirror-error");
	expect(m.unreachable().map((u) => u.server)).toEqual(["a"]);
});

test("a machine that can't be read is listed as unreachable from the first failure, and cleared when it answers again", async () => {
	const conf = mkdtempSync(`${tmpdir()}/chamberlain-away-`);
	dirs.push(conf);
	writeFileSync(`${conf}/read-token`, "tok"); chmodSync(`${conf}/read-token`, 0o600);
	let up = false;
	const connect = async () => {
		if (!up) throw new Error("connect ECONNREFUSED");
		return { ws: { close() {} }, call: async (_t: string, _p: unknown, onChunk?: (v: any) => void) => { onChunk?.({ kind: "snapshot", snapshot: { threads: [] } }); }, request: async () => ({ turnItems: [] }) };
	};
	const m = createMirror({ conf, servers: () => [{ name: "laptop", origin: "http://laptop", tokenFile: "read-token" }], skipThreads: () => [], log: () => {}, connect: connect as any, timeoutMs: 30 });
	await m.poll();
	const first = m.unreachable();
	expect(first.map((u) => u.server)).toEqual(["laptop"]);
	await m.poll();
	expect(m.unreachable()).toEqual(first);
	up = true;
	await m.poll();
	expect(m.unreachable()).toEqual([]);
});

test("a poll still running when the next tick comes is not doubled", async () => {
	const conf = mkdtempSync(`${tmpdir()}/chamberlain-overlap-`);
	dirs.push(conf);
	writeFileSync(`${conf}/read-token`, "tok"); chmodSync(`${conf}/read-token`, 0o600);
	let snapshots = 0;
	let release!: () => void;
	const gate = new Promise<void>((r) => { release = r; });
	const connect = async () => ({ ws: { close() {} }, call: async (_t: string, _p: unknown, onChunk?: (v: any) => void) => { snapshots++; await gate; onChunk?.({ kind: "snapshot", snapshot: { threads: [] } }); }, request: async () => ({}) });
	const m = createMirror({ conf, servers: () => [{ name: "a", origin: "http://a", tokenFile: "read-token" }], skipThreads: () => [], log: () => {}, connect: connect as any });
	const first = m.poll();
	await m.poll();
	release();
	await first;
	expect(snapshots).toBe(1);
});

test("the goal cache forgets a thread that left the scan, then reads it afresh", async () => {
	const at = new Date().toISOString();
	const { m, sent, set } = goalRig({ threads: [{ id: "g1", status: "completed", updatedAt: at }] });
	const reads = () => sent.filter((s) => s.tag === "orchestration.getThreadProjection").length;
	await m.poll();
	expect(reads()).toBe(1);
	set({ threads: [{ id: "g1", status: "running", updatedAt: at }] });
	await m.poll();
	expect(m.list()).toHaveLength(0);
	set({ threads: [{ id: "g1", status: "completed", updatedAt: at }] });
	await m.poll();
	expect(reads()).toBe(2);
});

test("a send whose reply timed out is never sent a second time, and its IDs are fixed by the card", async () => {
	const conf = mkdtempSync(`${tmpdir()}/chamberlain-dup-`);
	dirs.push(conf);
	for (const f of ["read-token", "op-token"]) { writeFileSync(`${conf}/${f}`, `tok-${f}`); chmodSync(`${conf}/${f}`, 0o600); }
	const now = new Date().toISOString();
	const dispatched: any[] = [];
	let slow = true;
	const connect = async () => ({
		ws: { close() {} },
		call: async (_t: string, _p: unknown, onChunk?: (v: any) => void) => { onChunk?.({ kind: "snapshot", snapshot: { threads: [{ id: "g1", status: "completed", updatedAt: now }] } }); },
		request: (tag: string, payload: any) => {
			if (tag === "orchestration.getThreadProjection") return Promise.resolve({ turnItems: [said(proposalText)], runs: [] });
			dispatched.push(payload);
			return slow ? new Promise(() => {}) : Promise.resolve({});
		},
	});
	const m = createMirror({ conf, servers: () => [{ name: "main", origin: "http://x", tokenFile: "read-token", operateTokenFile: "op-token" }], skipThreads: () => [], log: () => {}, connect: connect as any, timeoutMs: 30 });
	await m.poll();
	const c = m.list()[0]!;
	expect((await m.answer(c.id, 0, c.sig)).status).toBe(502);
	slow = false;
	expect((await m.answer(c.id, 0, c.sig)).status).toBe(409);
	expect(dispatched).toHaveLength(1);
	expect(dispatched[0].commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	const again = createMirror({ conf, servers: () => [{ name: "main", origin: "http://x", tokenFile: "read-token", operateTokenFile: "op-token" }], skipThreads: () => [], log: () => {}, connect: connect as any, timeoutMs: 30 });
	await again.poll();
	expect((await again.answer(c.id, 0, c.sig)).status).toBe(200);
	expect(dispatched[1].commandId).toBe(dispatched[0].commandId);
	expect(dispatched[1].messageId).toBe(dispatched[0].messageId);
});

test("an answer T3 refused outright may be tried again", async () => {
	const conf = mkdtempSync(`${tmpdir()}/chamberlain-refused-`);
	dirs.push(conf);
	for (const f of ["read-token", "op-token"]) { writeFileSync(`${conf}/${f}`, `tok-${f}`); chmodSync(`${conf}/${f}`, 0o600); }
	let refuse = true;
	const connect = async () => ({
		ws: { close() {} },
		call: async (_t: string, _p: unknown, onChunk?: (v: any) => void) => { onChunk?.({ kind: "snapshot", snapshot: { threads: [T] } }); },
		request: (tag: string) => tag === "orchestration.getThreadProjection" ? Promise.resolve({ turnItems: [question("r1")] }) : refuse ? Promise.reject(Error("rpc failure: no")) : Promise.resolve({}),
	});
	const m = createMirror({ conf, servers: () => [{ name: "main", origin: "http://x", tokenFile: "read-token", operateTokenFile: "op-token" }], skipThreads: () => [], log: () => {}, connect: connect as any });
	await m.poll();
	const c = m.list().find((x) => x.type === "question")!;
	expect((await m.answer(c.id, 0, c.sig)).status).toBe(502);
	refuse = false;
	expect((await m.answer(c.id, 0, c.sig)).status).toBe(200);
});

test("a connection that arrives after its deadline is closed", async () => {
	const conf = mkdtempSync(`${tmpdir()}/chamberlain-late-`);
	dirs.push(conf);
	writeFileSync(`${conf}/read-token`, "tok"); chmodSync(`${conf}/read-token`, 0o600);
	let closed = 0;
	const connect = () => new Promise((r) => setTimeout(() => r({ ws: { close() { closed++; } }, call: async () => {}, request: async () => ({}) }), 60));
	const m = createMirror({ conf, servers: () => [{ name: "a", origin: "http://a", tokenFile: "read-token" }], skipThreads: () => [], log: () => {}, connect: connect as any, timeoutMs: 20 });
	await m.poll();
	await new Promise((r) => setTimeout(r, 80));
	expect(closed).toBe(1);
});

test("two answers to one card arriving together send it once", async () => {
	const { m, sent } = rig();
	await m.poll();
	const { id, sig } = m.list()[0]!;
	const [a, b] = await Promise.all([m.answer(id, 0, sig), m.answer(id, 0, sig)]);
	expect([a.status, b.status].sort()).toEqual([200, 409]);
	expect(sent.filter((s) => s.tag === "orchestration.dispatchCommand")).toHaveLength(1);
});

test("an answer refused before anything was sent does not block a later answer", async () => {
	const { m, setItems, sent } = rig();
	await m.poll();
	const { id, sig } = m.list()[0]!;
	const keep = question("r1");
	setItems(() => []);
	expect((await m.answer(id, 0, sig)).status).toBe(409);
	setItems(() => [keep]);
	await m.poll();
	const again = m.list()[0]!;
	expect((await m.answer(again.id, 0, again.sig)).status).toBe(200);
	expect(sent.filter((s) => s.tag === "orchestration.dispatchCommand")).toHaveLength(1);
});

describe("send: the adapter's message.dispatch, through the page's threadSender", () => {
	const conf = () => { const d = mkdtempSync(`${tmpdir()}/chamberlain-sender-`); dirs.push(d); writeFileSync(`${d}/op-token`, "secret-op", { mode: 0o600 }); return d; };
	const fake = (runs: { id: string; status: string }[], fail?: string) => {
		const calls: { method: string; params: Record<string, unknown> }[] = [];
		const connect = async () => ({
			request: async (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); if (fail && method === "orchestration.dispatchCommand") throw Error(`${fail} secret-op`); return method === "orchestration.getThreadProjection" ? { runs } : {}; },
			call: async () => {}, ws: { close() {} },
		});
		return { calls, connect: connect as never };
	};
	test("dispatches one Steward-signed message, steering a running turn, with IDs fixed by the seed", async () => {
		const c = conf();
		const f = fake([{ id: "run-1", status: "completed" }, { id: "run-2", status: "running" }]);
		const send = threadSenderFor({ conf: c, servers: () => [{ name: "main", origin: "http://x", tokenFile: "t", operateTokenFile: "op-token" }], connect: f.connect, log: () => {}, skipThreads: () => [] });
		const r = await send("main", "thread-1", "Steward, hello", "relay\0Q-abcd");
		expect(r.ok).toBe(true);
		const d = f.calls.filter((x) => x.method === "orchestration.dispatchCommand");
		expect(d).toHaveLength(1);
		expect(d[0]!.params).toEqual(expect.objectContaining({ type: "message.dispatch", threadId: "thread-1", text: "Steward, hello", createdBy: "agent", creationSource: "mcp", dispatchMode: { type: "steer_active", targetRunId: "run-2" } }));
		const f2 = fake([]);
		await threadSenderFor({ conf: c, servers: () => [{ name: "main", origin: "http://x", tokenFile: "t", operateTokenFile: "op-token" }], connect: f2.connect, log: () => {}, skipThreads: () => [] })("main", "thread-1", "x", "relay\0Q-abcd");
		const d2 = f2.calls.find((x) => x.method === "orchestration.dispatchCommand")!.params;
		expect(d2.dispatchMode).toEqual({ type: "start_immediately" });
		expect(d2.commandId).toBe(d[0]!.params.commandId as string);
		expect(d2.messageId).toBe(d[0]!.params.messageId as string);
	});
	test("refuses a server with no operate token, an unknown server, and redacts the token from a failure", async () => {
		const c = conf();
		const f = fake([], "rpc failure");
		const servers = () => [{ name: "main", origin: "http://x", tokenFile: "t", operateTokenFile: "op-token" }, { name: "laptop", origin: "http://y", tokenFile: "t", operateTokenFile: null }];
		const send = threadSenderFor({ conf: c, servers, connect: f.connect, log: () => {}, skipThreads: () => [] });
		expect((await send("laptop", "t", "x", "s")).ok).toBe(false);
		expect((await send("remote", "t", "x", "s")).detail).toContain("no server named remote");
		const r = await send("main", "t", "x", "s");
		expect(r.ok).toBe(false);
		expect(r.detail).toContain("rpc failure");
		expect(r.detail).not.toContain("secret-op");
	});
});
