/** waiting, continued: see waiting.test.ts for the overview. */

import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { useAdaptersT3WaitingFixtures } from "../../testing/adapters-t3-waiting-fixtures.ts";
import { withAnswerRights } from "../../web/waiting.ts";
import { cardsFrom, goalProposal } from "./wait-cards.ts";
import type { Server } from "./wait-ctx.ts";

const { createMirror, dirs, T, rig, approval, GOAL, said, proposalText, goalRig } = useAdaptersT3WaitingFixtures();

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

test("an approval keeps its command byte for byte, and is read-only without the token or without a command", () => {
	const multi = "printf 'a  b'\n  && true";
	const c = cardsFrom({ server: "main", canAnswer: true, thread: T }, [approval("a1", { prompt: multi })])[0]!;
	expect(c.command).toBe(multi);
	expect(cardsFrom({ server: "laptop", canAnswer: false, thread: T }, [approval("a1")])[0]!.answerable).toBe(false);
	expect(cardsFrom({ server: "laptop", canAnswer: false, thread: T }, [approval("a1")])[0]!.options).toEqual([]);
	expect(
		cardsFrom({ server: "main", canAnswer: true, thread: T }, [approval("a1", { prompt: "  " })])[0]!.answerable,
	).toBe(false);
	expect(
		cardsFrom({ server: "main", canAnswer: true, thread: T }, [approval("a1", { prompt: "true " })])[0]!.sig,
	).not.toBe(c.sig);
});

test("approve once sends accept, decline sends decline, never anything wider, and the log has the full command", async () => {
	for (const [choice, decision] of [
		[0, "accept"],
		[1, "decline"],
	] as const) {
		const { m, sent, logs } = rig({ items: () => [approval("a1", { prompt: "true\n# second line" })] });
		await m.poll();
		const { id, sig } = m.list()[0]!;
		expect((await m.answer(id, choice, sig)).status).toBe(200);
		const respond = sent.find((s) => s.tag === "orchestration.dispatchCommand")!;
		expect(respond.payload).toMatchObject({
			type: "runtime-request.respond",
			threadId: "th-1",
			requestId: "a1",
			decision,
		});
		expect(respond.payload.answers).toBeUndefined();
		expect(respond.token).toBe("tok-op-token");
		const entry = logs.find((l) => l.e === "mirror-approval-answered")!;
		expect(entry.data).toMatchObject({
			decision,
			command: "true\n# second line",
			reason: "harmless test",
			requestKind: "command",
		});
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
		{
			type: "user_input_request",
			status: "waiting",
			requestId: "a1",
			prompt: "true",
			questions: [{ id: "0", question: "true", options: [{ label: "Approve once" }, { label: "Decline" }] }],
		},
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

test("a goal proposal is the last message's fenced /goal block, with no reply after it", () => {
	expect(goalProposal([said(proposalText)])).toEqual({ messageId: "m1", goal: GOAL });
	expect(goalProposal([said(proposalText), { type: "user_message", status: "completed", text: "no" }])).toBeUndefined();
	expect(goalProposal([said(proposalText, { status: "running" })])).toBeUndefined();
	expect(goalProposal([said("```ts\nconst x = 1;\n```")])).toBeUndefined();
	expect(goalProposal([said(proposalText), { type: "command_execution", status: "completed" }])).toEqual({
		messageId: "m1",
		goal: GOAL,
	});
	const two = `\`\`\`markdown\n/goal old\n\`\`\`\nrevised:\n\`\`\`\n/goal new one\n\`\`\``;
	expect(goalProposal([said(two)])!.goal).toBe("/goal new one");
});

test("an idle thread proposing a goal is listed, and accepting sends the exact /goal text as his message", async () => {
	const { m, sent } = goalRig();
	await m.poll();
	const c = m.list()[0]!;
	expect([c.type, c.answerable, c.command, c.options.map((o) => o.label)]).toEqual([
		"goal",
		true,
		GOAL,
		["Accept goal"],
	]);
	expect(c.question).toBe("Fix #7478 so the gate reads every body.");
	expect((await m.answer(c.id, 0, c.sig)).status).toBe(200);
	const d = sent.find((s) => s.tag === "orchestration.dispatchCommand")!;
	expect(d.payload).toMatchObject({
		type: "message.dispatch",
		threadId: "g1",
		text: GOAL,
		createdBy: "user",
		creationSource: "server",
		dispatchMode: { type: "start_immediately" },
	});
	expect(d.token).toBe("tok-op-token");
	expect(m.list()).toHaveLength(0);
});

test("a busy, settled, archived or stale thread is not scanned, and an unchanged thread is not re-read", async () => {
	const old = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
	const now = new Date().toISOString();
	const { m, sent, set } = goalRig({
		threads: [
			{ id: "busy", status: "running", updatedAt: now },
			{ id: "settled", status: "completed", updatedAt: now, settledAt: now },
			{ id: "arch", status: "completed", updatedAt: now, archivedAt: now },
			{ id: "stale", status: "completed", updatedAt: old },
			{ id: "ok", status: "completed", updatedAt: now },
		],
	});
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
	const list: Server[] = [
		{ name: "__proto__", origin: "http://a", tokenFile: "r" },
		{ name: "constructor", origin: "http://b", tokenFile: "r" },
		{ name: "prototype", origin: "http://c", tokenFile: "r" },
	];
	const tokens = JSON.parse('{"__proto__": "op", "constructor": "op", "prototype": "op"}');
	expect(withAnswerRights(list, undefined, tokens).map((s) => s.operateTokenFile)).toEqual([null, null, null]);
});

test("a server that never answers a projection read can't stall the poll; the next server is still read", async () => {
	const conf = mkdtempSync(`${tmpdir()}/chamberlain-stall-`);
	dirs.push(conf);
	writeFileSync(`${conf}/read-token`, "tok");
	chmodSync(`${conf}/read-token`, 0o600);
	const now = new Date().toISOString();
	const reads: string[] = [];
	const connect = async (origin: string) => ({
		ws: { close() {} },
		call: async (_t: string, _p: unknown, onChunk?: (v: any) => void) => {
			onChunk?.({
				kind: "snapshot",
				snapshot: { threads: [{ id: `${origin}-t`, status: "completed", updatedAt: now }] },
			});
		},
		request: (_tag: string, payload: any) => {
			reads.push(payload.threadId);
			return origin === "http://hang" ? new Promise(() => {}) : Promise.resolve({ turnItems: [said(proposalText)] });
		},
	});
	const logs: string[] = [];
	const m = createMirror({
		conf,
		servers: () => [
			{ name: "a", origin: "http://hang", tokenFile: "read-token" },
			{ name: "b", origin: "http://ok", tokenFile: "read-token" },
		],
		skipThreads: () => [],
		log: (e) => logs.push(e),
		connect: connect as any,
		timeoutMs: 30,
	});
	await m.poll();
	expect(reads).toEqual(["http://hang-t", "http://ok-t"]);
	expect(m.list().map((c) => c.server)).toEqual(["b"]);
	expect(logs).toContain("mirror-error");
	expect(m.unreachable().map((u) => u.server)).toEqual(["a"]);
});

test("a machine that can't be read is listed as unreachable from the first failure, and cleared when it answers again", async () => {
	const conf = mkdtempSync(`${tmpdir()}/chamberlain-away-`);
	dirs.push(conf);
	writeFileSync(`${conf}/read-token`, "tok");
	chmodSync(`${conf}/read-token`, 0o600);
	let up = false;
	const connect = async () => {
		if (!up) throw new Error("connect ECONNREFUSED");
		return {
			ws: { close() {} },
			call: async (_t: string, _p: unknown, onChunk?: (v: any) => void) => {
				onChunk?.({ kind: "snapshot", snapshot: { threads: [] } });
			},
			request: async () => ({ turnItems: [] }),
		};
	};
	const m = createMirror({
		conf,
		servers: () => [{ name: "laptop", origin: "http://laptop", tokenFile: "read-token" }],
		skipThreads: () => [],
		log: () => {},
		connect: connect as any,
		timeoutMs: 30,
	});
	await m.poll();
	const first = m.unreachable();
	expect(first.map((u) => u.server)).toEqual(["laptop"]);
	await m.poll();
	expect(m.unreachable()).toEqual(first);
	up = true;
	await m.poll();
	expect(m.unreachable()).toEqual([]);
});
