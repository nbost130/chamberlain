/** waiting, continued: see waiting.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { useAdaptersT3WaitingFixtures } from "../../testing/adapters-t3-waiting-fixtures.ts";

const { createMirror, threadSenderFor, dirs, question, T, rig, said, proposalText, goalRig } =
	useAdaptersT3WaitingFixtures();

test("a poll still running when the next tick comes is not doubled", async () => {
	const conf = mkdtempSync(`${tmpdir()}/chamberlain-overlap-`);
	dirs.push(conf);
	writeFileSync(`${conf}/read-token`, "tok");
	chmodSync(`${conf}/read-token`, 0o600);
	let snapshots = 0;
	let release!: () => void;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	const connect = async () => ({
		ws: { close() {} },
		call: async (_t: string, _p: unknown, onChunk?: (v: any) => void) => {
			snapshots++;
			await gate;
			onChunk?.({ kind: "snapshot", snapshot: { threads: [] } });
		},
		request: async () => ({}),
	});
	const m = createMirror({
		conf,
		servers: () => [{ name: "a", origin: "http://a", tokenFile: "read-token" }],
		skipThreads: () => [],
		log: () => {},
		connect: connect as any,
	});
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
	for (const f of ["read-token", "op-token"]) {
		writeFileSync(`${conf}/${f}`, `tok-${f}`);
		chmodSync(`${conf}/${f}`, 0o600);
	}
	const now = new Date().toISOString();
	const dispatched: any[] = [];
	let slow = true;
	const connect = async () => ({
		ws: { close() {} },
		call: async (_t: string, _p: unknown, onChunk?: (v: any) => void) => {
			onChunk?.({ kind: "snapshot", snapshot: { threads: [{ id: "g1", status: "completed", updatedAt: now }] } });
		},
		request: (tag: string, payload: any) => {
			if (tag === "orchestration.getThreadProjection")
				return Promise.resolve({ turnItems: [said(proposalText)], runs: [] });
			dispatched.push(payload);
			return slow ? new Promise(() => {}) : Promise.resolve({});
		},
	});
	const m = createMirror({
		conf,
		servers: () => [{ name: "main", origin: "http://x", tokenFile: "read-token", operateTokenFile: "op-token" }],
		skipThreads: () => [],
		log: () => {},
		connect: connect as any,
		timeoutMs: 30,
	});
	await m.poll();
	const c = m.list()[0]!;
	expect((await m.answer(c.id, 0, c.sig)).status).toBe(502);
	slow = false;
	expect((await m.answer(c.id, 0, c.sig)).status).toBe(409);
	expect(dispatched).toHaveLength(1);
	expect(dispatched[0].commandId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	const again = createMirror({
		conf,
		servers: () => [{ name: "main", origin: "http://x", tokenFile: "read-token", operateTokenFile: "op-token" }],
		skipThreads: () => [],
		log: () => {},
		connect: connect as any,
		timeoutMs: 30,
	});
	await again.poll();
	expect((await again.answer(c.id, 0, c.sig)).status).toBe(200);
	expect(dispatched[1].commandId).toBe(dispatched[0].commandId);
	expect(dispatched[1].messageId).toBe(dispatched[0].messageId);
});

test("an answer T3 refused outright may be tried again", async () => {
	const conf = mkdtempSync(`${tmpdir()}/chamberlain-refused-`);
	dirs.push(conf);
	for (const f of ["read-token", "op-token"]) {
		writeFileSync(`${conf}/${f}`, `tok-${f}`);
		chmodSync(`${conf}/${f}`, 0o600);
	}
	let refuse = true;
	const connect = async () => ({
		ws: { close() {} },
		call: async (_t: string, _p: unknown, onChunk?: (v: any) => void) => {
			onChunk?.({ kind: "snapshot", snapshot: { threads: [T] } });
		},
		request: (tag: string) =>
			tag === "orchestration.getThreadProjection"
				? Promise.resolve({ turnItems: [question("r1")] })
				: refuse
					? Promise.reject(Error("rpc failure: no"))
					: Promise.resolve({}),
	});
	const m = createMirror({
		conf,
		servers: () => [{ name: "main", origin: "http://x", tokenFile: "read-token", operateTokenFile: "op-token" }],
		skipThreads: () => [],
		log: () => {},
		connect: connect as any,
	});
	await m.poll();
	const c = m.list().find((x) => x.type === "question")!;
	expect((await m.answer(c.id, 0, c.sig)).status).toBe(502);
	refuse = false;
	expect((await m.answer(c.id, 0, c.sig)).status).toBe(200);
});

test("a connection that arrives after its deadline is closed", async () => {
	const conf = mkdtempSync(`${tmpdir()}/chamberlain-late-`);
	dirs.push(conf);
	writeFileSync(`${conf}/read-token`, "tok");
	chmodSync(`${conf}/read-token`, 0o600);
	let closed = 0;
	const connect = () =>
		new Promise((r) =>
			setTimeout(
				() =>
					r({
						ws: {
							close() {
								closed++;
							},
						},
						call: async () => {},
						request: async () => ({}),
					}),
				60,
			),
		);
	const m = createMirror({
		conf,
		servers: () => [{ name: "a", origin: "http://a", tokenFile: "read-token" }],
		skipThreads: () => [],
		log: () => {},
		connect: connect as any,
		timeoutMs: 20,
	});
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
	const conf = () => {
		const d = mkdtempSync(`${tmpdir()}/chamberlain-sender-`);
		dirs.push(d);
		writeFileSync(`${d}/op-token`, "secret-op", { mode: 0o600 });
		return d;
	};
	const fake = (runs: { id: string; status: string }[], fail?: string) => {
		const calls: { method: string; params: Record<string, unknown> }[] = [];
		const connect = async () => ({
			request: async (method: string, params: Record<string, unknown>) => {
				calls.push({ method, params });
				if (fail && method === "orchestration.dispatchCommand") throw Error(`${fail} secret-op`);
				return method === "orchestration.getThreadProjection" ? { runs } : {};
			},
			call: async () => {},
			ws: { close() {} },
		});
		return { calls, connect: connect as never };
	};
	test("dispatches one Steward-signed message, steering a running turn, with IDs fixed by the seed", async () => {
		const c = conf();
		const f = fake([
			{ id: "run-1", status: "completed" },
			{ id: "run-2", status: "running" },
		]);
		const send = threadSenderFor({
			conf: c,
			servers: () => [{ name: "main", origin: "http://x", tokenFile: "t", operateTokenFile: "op-token" }],
			connect: f.connect,
			log: () => {},
			skipThreads: () => [],
		});
		const r = await send("main", "thread-1", "Steward, hello", "relay\0Q-abcd");
		expect(r.ok).toBe(true);
		const d = f.calls.filter((x) => x.method === "orchestration.dispatchCommand");
		expect(d).toHaveLength(1);
		expect(d[0]!.params).toEqual(
			expect.objectContaining({
				type: "message.dispatch",
				threadId: "thread-1",
				text: "Steward, hello",
				createdBy: "agent",
				creationSource: "mcp",
				dispatchMode: { type: "steer_active", targetRunId: "run-2" },
			}),
		);
		const f2 = fake([]);
		await threadSenderFor({
			conf: c,
			servers: () => [{ name: "main", origin: "http://x", tokenFile: "t", operateTokenFile: "op-token" }],
			connect: f2.connect,
			log: () => {},
			skipThreads: () => [],
		})("main", "thread-1", "x", "relay\0Q-abcd");
		const d2 = f2.calls.find((x) => x.method === "orchestration.dispatchCommand")!.params;
		expect(d2.dispatchMode).toEqual({ type: "start_immediately" });
		expect(d2.commandId).toBe(d[0]!.params.commandId as string);
		expect(d2.messageId).toBe(d[0]!.params.messageId as string);
	});
	test("refuses a server with no operate token, an unknown server, and redacts the token from a failure", async () => {
		const c = conf();
		const f = fake([], "rpc failure");
		const servers = () => [
			{ name: "main", origin: "http://x", tokenFile: "t", operateTokenFile: "op-token" },
			{ name: "laptop", origin: "http://y", tokenFile: "t", operateTokenFile: null },
		];
		const send = threadSenderFor({ conf: c, servers, connect: f.connect, log: () => {}, skipThreads: () => [] });
		expect((await send("laptop", "t", "x", "s")).ok).toBe(false);
		expect((await send("remote", "t", "x", "s")).detail).toContain("no server named remote");
		const r = await send("main", "t", "x", "s");
		expect(r.ok).toBe(false);
		expect(r.detail).toContain("rpc failure");
		expect(r.detail).not.toContain("secret-op");
	});
});
