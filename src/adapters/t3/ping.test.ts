import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	activeRunOf,
	createRpcPing,
	daemonPingRefusal,
	IDENTITIES,
	messageCommand,
	NOT_SENT,
	sendFailure,
	stableId,
} from "./ping.ts";

describe("messageCommand: the one message.dispatch", () => {
	test("each identity is signed the way its sender always was", () => {
		expect(IDENTITIES.steward).toEqual({ createdBy: "agent", creationSource: "mcp" });
		expect(IDENTITIES.daemon).toEqual({ createdBy: "agent", creationSource: "server" });
		expect(IDENTITIES.operator).toEqual({ createdBy: "user", creationSource: "server" });
	});
	test("a seed fixes the command and message ids; no seed gives fresh ones", () => {
		const a = messageCommand({ threadId: "t", text: "x", seed: "s", identity: "steward" });
		const b = messageCommand({ threadId: "t", text: "x", seed: "s", identity: "steward" });
		expect(a.commandId).toBe(b.commandId);
		expect(a.messageId).toBe(b.messageId);
		expect(a.commandId).toBe(stableId("cmd\0s"));
		expect(messageCommand({ threadId: "t", text: "x", identity: "steward" }).commandId).not.toBe(
			messageCommand({ threadId: "t", text: "x", identity: "steward" }).commandId,
		);
	});
	test("it steers a run that is going and starts one otherwise; `start` always starts", () => {
		expect(messageCommand({ threadId: "t", text: "x", identity: "steward", activeRunId: "r1" }).dispatchMode).toEqual({
			type: "steer_active",
			targetRunId: "r1",
		});
		expect(messageCommand({ threadId: "t", text: "x", identity: "steward" }).dispatchMode).toEqual({
			type: "start_immediately",
		});
		expect(
			messageCommand({ threadId: "t", text: "x", identity: "operator", activeRunId: "r1", start: true }).dispatchMode,
		).toEqual({ type: "start_immediately" });
	});
	test("activeRunOf picks the newest run that is going", () => {
		expect(
			activeRunOf([
				{ id: "a", status: "completed" },
				{ id: "b", status: "running" },
				{ id: "c", status: "failed" },
			]),
		).toBe("b");
		expect(activeRunOf([{ id: "a", status: "failed" }])).toBeUndefined();
	});
});

describe("createRpcPing", () => {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-ping-`);
	mkdirSync(root, { recursive: true });
	writeFileSync(`${root}/op-token`, "OPSECRET", { mode: 0o600 });
	const server = { name: "laptop", origin: "http://x", tokenFile: "t", operateTokenFile: "op-token" };
	const fakeConn =
		(runs: { id: string; status: string }[], sent: Record<string, unknown>[], fail?: string) => async () => ({
			ws: { close() {} },
			request: async (m: string, p: unknown) => {
				if (m === "orchestration.getThreadProjection") return { runs };
				if (fail) throw Error(fail);
				sent.push(p as Record<string, unknown>);
				return {};
			},
		});
	test("a daemon ping is one agent/server message.dispatch that starts a run on a failed thread", async () => {
		const sent: Record<string, unknown>[] = [];
		const ping = createRpcPing({
			server,
			conf: root,
			connect: fakeConn([{ id: "r1", status: "failed" }], sent) as never,
		});
		expect(await ping("t1", "retry", "recover:r1", "daemon")).toEqual({ ok: true, detail: "sent to laptop:t1" });
		expect(sent[0]).toMatchObject({
			type: "message.dispatch",
			threadId: "t1",
			text: "retry",
			createdBy: "agent",
			creationSource: "server",
			dispatchMode: { type: "queue_after_active" },
		});
	});
	test("a server without an operate token is refused", async () => {
		const r = await createRpcPing({
			server: { ...server, operateTokenFile: undefined },
			conf: root,
			connect: fakeConn([], []) as never,
		})("t", "x", "s");
		expect(r.ok).toBe(false);
		expect(r.detail).toMatch(/no operate token/);
	});
	test("an error never carries the token", async () => {
		const r = await createRpcPing({ server, conf: root, connect: fakeConn([], [], "bad OPSECRET here") as never })(
			"t",
			"x",
			"s",
		);
		expect(r.ok).toBe(false);
		expect(r.detail).not.toContain("OPSECRET");
		rmSync(root, { recursive: true, force: true });
	});
});

describe("there is one send path", () => {
	const SRC = new URL("../..", import.meta.url).pathname;
	const walk = (dir: string): string[] =>
		readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
			e.isDirectory()
				? walk(join(dir, e.name))
				: e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")
					? [join(dir, e.name)]
					: [],
		);
	const files = walk(SRC).map((f) => [relative(SRC, f), readFileSync(f, "utf8")] as const);
	test("only ping.ts builds a message.dispatch command", () => {
		expect(files.filter(([, c]) => /["'`]message\.dispatch["'`]/.test(c)).map(([f]) => f)).toEqual([
			"adapters/t3/ping.ts",
		]);
	});
	test("only ping.ts spawns the T3 CLI to send a message", () => {
		expect(files.filter(([, c]) => /["'`]thread["'`]\s*,\s*["'`]send["'`]/.test(c)).map(([f]) => f)).toEqual([
			"adapters/t3/ping.ts",
		]);
	});
});

describe("the daemon's ping never steers a run and never writes into a waiting thread", () => {
	const failed = [{ id: "r1", ordinal: 1, status: "failed" }];
	test("daemonPingRefusal: only a thread whose newest run failed, with nothing going and nothing waiting, may be pinged", () => {
		expect(daemonPingRefusal({ runs: failed, turnItems: [] })).toBeUndefined();
		expect(daemonPingRefusal({ runs: [...failed, { id: "r2", ordinal: 2, status: "running" }] })).toMatch(/active/);
		expect(daemonPingRefusal({ runs: [...failed, { id: "r2", ordinal: 2, status: "waiting" }] })).toMatch(/active/);
		expect(daemonPingRefusal({ runs: failed, turnItems: [{ status: "waiting" }] })).toMatch(
			/card, approval or question/,
		);
		expect(daemonPingRefusal({ runs: [...failed, { id: "r2", ordinal: 2, status: "completed" }] })).toMatch(
			/completed, not failed/,
		);
		expect(daemonPingRefusal({ runs: [] })).toMatch(/missing, not failed/);
	});
	const root = mkdtempSync(`${tmpdir()}/chamberlain-ping2-`);
	writeFileSync(`${root}/op-token`, "OPSECRET", { mode: 0o600 });
	const server = { name: "laptop", origin: "http://x", tokenFile: "t", operateTokenFile: "op-token" };
	const conn = (proj: Record<string, unknown>, sent: unknown[]) => async () => ({
		ws: { close() {} },
		request: async (m: string, p: unknown) => {
			if (m === "orchestration.getThreadProjection") return proj;
			sent.push(p);
			return {};
		},
	});
	test("a daemon ping into a thread that is waiting or running is refused at the transport, and nothing is dispatched", async () => {
		for (const proj of [
			{ runs: failed, turnItems: [{ status: "waiting" }] },
			{ runs: [{ id: "r2", ordinal: 2, status: "running" }], turnItems: [] },
		]) {
			const sent: unknown[] = [];
			const r = await createRpcPing({ server, conf: root, connect: conn(proj, sent) as never })(
				"t1",
				"retry",
				"recover:r1",
				"daemon",
			);
			expect(r.ok).toBe(false);
			expect(r.detail).toMatch(/^not sent: /);
			expect(sent).toEqual([]);
		}
	});
	test("the Steward's own ping is unchanged: it still steers a run that is going", async () => {
		const sent: Record<string, unknown>[] = [];
		const r = await createRpcPing({
			server,
			conf: root,
			connect: conn({ runs: [{ id: "r2", ordinal: 2, status: "running" }] }, sent) as never,
		})("t1", "go on", "s", "steward");
		expect(r.ok).toBe(true);
		expect(sent[0]).toMatchObject({ dispatchMode: { type: "steer_active", targetRunId: "r2" } });
	});
});

describe("the daemon's ping is always queued, never a steer", () => {
	const root2 = mkdtempSync(`${tmpdir()}/ping-r2-`);
	writeFileSync(`${root2}/op-token`, "OPSECRET", { mode: 0o600 });
	const server = { name: "laptop", origin: "http://x", tokenFile: "t", operateTokenFile: "op-token" };
	const root = root2;
	test("messageCommand with the daemon identity can only be built in queue mode, whatever else is passed", () => {
		for (const o of [{}, { activeRunId: "r1" }, { activeRunId: "r1", start: true }, { start: true }]) {
			const c = messageCommand({ threadId: "t", text: "x", identity: "daemon", ...o });
			expect(c.dispatchMode).toEqual({ type: "queue_after_active" });
		}
		expect(messageCommand({ threadId: "t", text: "x", identity: "steward", activeRunId: "r1" }).dispatchMode).toEqual({
			type: "steer_active",
			targetRunId: "r1",
		});
	});
	test("an approval that opens between the final read and the send still does no harm: the message is delivered in queue mode, never a steer", async () => {
		const sent: Record<string, unknown>[] = [];
		let reads = 0;
		// The read finds an idle, failed thread. By the time the send arrives, a run is active and waiting on an approval.
		const conn = async () => ({
			ws: { close() {} },
			request: async (m: string, p: unknown) => {
				if (m === "orchestration.getThreadProjection") {
					reads++;
					return { runs: [{ id: "r1", ordinal: 1, status: "failed" }], turnItems: [] };
				}
				sent.push(p as Record<string, unknown>);
				return {};
			},
		});
		const r = await createRpcPing({ server, conf: root, connect: conn as never })(
			"t1",
			"retry",
			"recover:t1:1",
			"daemon",
		);
		expect(r.ok).toBe(true);
		expect(reads).toBe(1);
		expect(sent).toHaveLength(1);
		const mode = sent[0]!.dispatchMode as { type: string; targetRunId?: string };
		expect(mode).toEqual({ type: "queue_after_active" });
		expect(mode.type).not.toBe("steer_active");
		expect(mode.targetRunId).toBeUndefined();
	});
	test("a refusal that sent nothing says so, so the caller can withdraw its record", async () => {
		const sent: unknown[] = [];
		const conn = async () => ({
			ws: { close() {} },
			request: async (m: string, p: unknown) => {
				if (m === "orchestration.getThreadProjection") return { runs: [{ id: "r2", ordinal: 2, status: "running" }] };
				sent.push(p);
				return {};
			},
		});
		const r = await createRpcPing({ server, conf: root, connect: conn as never })("t1", "retry", "s", "daemon");
		expect(r.ok).toBe(false);
		expect(r.detail.startsWith(NOT_SENT)).toBe(true);
		expect(sent).toEqual([]);
		const noToken = await createRpcPing({
			server: { ...server, operateTokenFile: undefined },
			conf: root,
			connect: conn as never,
		})("t1", "x", "s", "daemon");
		expect(noToken.detail.startsWith(NOT_SENT)).toBe(true);
	});
});

describe("every send error is classified before the commit, and only a confirmed acceptance is sent", () => {
	const dir = mkdtempSync(`${tmpdir()}/ping-r3-`);
	writeFileSync(`${dir}/op-token`, "OPSECRET", { mode: 0o600 });
	const server = { name: "laptop", origin: "http://x", tokenFile: "t", operateTokenFile: "op-token" };
	const root = dir;
	const failedProj = { runs: [{ id: "r1", ordinal: 1, status: "failed" }], turnItems: [] };
	/** A connection that fails at one stage. */
	const stage =
		(at: "connect" | "projection" | "dispatch-refused" | "dispatch-timeout" | "dispatch-dropped" | "ok") =>
		async () => {
			if (at === "connect") throw Error("connect ECONNREFUSED");
			return {
				ws: { close() {} },
				request: async (m: string) => {
					if (m === "orchestration.getThreadProjection") {
						if (at === "projection") throw Error("projection read timed out");
						return failedProj;
					}
					if (at === "dispatch-refused") throw Error(`rpc failure: ${JSON.stringify({ _tag: "Failure" })}`);
					if (at === "dispatch-timeout") throw Error("send timed out after 10000 ms");
					if (at === "dispatch-dropped") throw Error("socket closed");
					return {};
				},
			};
		};
	const run = (at: Parameters<typeof stage>[0]) => {
		const conn = stage(at);
		return createRpcPing({ server, conf: root, connect: conn as never })("t1", "retry", "recover:t1:1", "daemon");
	};
	test("a failure before the dispatch call (connect, projection read) is not sent", async () => {
		for (const at of ["connect", "projection"] as const) {
			const r = await run(at);
			expect(r.ok).toBe(false);
			expect(r.detail.startsWith(NOT_SENT)).toBe(true);
		}
	});
	test("T3 refusing the command outright is not sent", async () => {
		const r = await run("dispatch-refused");
		expect(r.ok).toBe(false);
		expect(r.detail.startsWith(NOT_SENT)).toBe(true);
	});
	test("a timeout or a dropped socket after the dispatch may have landed: it carries no 'not sent' prefix", async () => {
		for (const at of ["dispatch-timeout", "dispatch-dropped"] as const) {
			const r = await run(at);
			expect(r.ok).toBe(false);
			expect(r.detail.startsWith(NOT_SENT)).toBe(false);
		}
	});
	test("only a resolved dispatch is a confirmed send", async () => {
		expect((await run("ok")).ok).toBe(true);
	});
	test("sendFailure: the token is redacted, and the prefix depends only on whether the dispatch was reached and whether T3 refused it", () => {
		expect(sendFailure(Error("x OPSECRET y"), false, ["OPSECRET"])).toBe("not sent: Error: x [redacted] y");
		expect(sendFailure(Error("socket closed"), true, [])).toBe("Error: socket closed");
		expect(sendFailure(Error("rpc failure: {}"), true, [])).toMatch(/^not sent: /);
	});
});
