import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { activeRunOf, createRpcPing, IDENTITIES, messageCommand, stableId } from "./ping.ts";

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
		expect(messageCommand({ threadId: "t", text: "x", identity: "steward" }).commandId).not.toBe(messageCommand({ threadId: "t", text: "x", identity: "steward" }).commandId);
	});
	test("it steers a run that is going and starts one otherwise; `start` always starts", () => {
		expect(messageCommand({ threadId: "t", text: "x", identity: "steward", activeRunId: "r1" }).dispatchMode).toEqual({ type: "steer_active", targetRunId: "r1" });
		expect(messageCommand({ threadId: "t", text: "x", identity: "steward" }).dispatchMode).toEqual({ type: "start_immediately" });
		expect(messageCommand({ threadId: "t", text: "x", identity: "operator", activeRunId: "r1", start: true }).dispatchMode).toEqual({ type: "start_immediately" });
	});
	test("activeRunOf picks the newest run that is going", () => {
		expect(activeRunOf([{ id: "a", status: "completed" }, { id: "b", status: "running" }, { id: "c", status: "failed" }])).toBe("b");
		expect(activeRunOf([{ id: "a", status: "failed" }])).toBeUndefined();
	});
});

describe("createRpcPing", () => {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-ping-`);
	mkdirSync(root, { recursive: true });
	writeFileSync(`${root}/op-token`, "OPSECRET", { mode: 0o600 });
	const server = { name: "mac", origin: "http://x", tokenFile: "t", operateTokenFile: "op-token" };
	const fakeConn = (runs: { id: string; status: string }[], sent: Record<string, unknown>[], fail?: string) => async () => ({
		ws: { close() {} },
		request: async (m: string, p: unknown) => { if (m === "orchestration.getThreadProjection") return { runs }; if (fail) throw Error(fail); sent.push(p as Record<string, unknown>); return {}; },
	});
	test("a daemon ping is one agent/server message.dispatch that starts a run on a failed thread", async () => {
		const sent: Record<string, unknown>[] = [];
		const ping = createRpcPing({ server, conf: root, connect: fakeConn([{ id: "r1", status: "failed" }], sent) as never });
		expect(await ping("t1", "retry", "recover:r1", "daemon")).toEqual({ ok: true, detail: "sent to mac:t1" });
		expect(sent[0]).toMatchObject({ type: "message.dispatch", threadId: "t1", text: "retry", createdBy: "agent", creationSource: "server", dispatchMode: { type: "start_immediately" } });
	});
	test("a server without an operate token is refused", async () => {
		const r = await createRpcPing({ server: { ...server, operateTokenFile: undefined }, conf: root, connect: fakeConn([], []) as never })("t", "x", "s");
		expect(r.ok).toBe(false);
		expect(r.detail).toMatch(/no operate token/);
	});
	test("an error never carries the token", async () => {
		const r = await createRpcPing({ server, conf: root, connect: fakeConn([], [], "bad OPSECRET here") as never })("t", "x", "s");
		expect(r.ok).toBe(false);
		expect(r.detail).not.toContain("OPSECRET");
		rmSync(root, { recursive: true, force: true });
	});
});

describe("there is one send path", () => {
	const SRC = new URL("../..", import.meta.url).pathname;
	const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(dir, e.name)] : []));
	const files = walk(SRC).map((f) => [relative(SRC, f), readFileSync(f, "utf8")] as const);
	test("only ping.ts builds a message.dispatch command", () => {
		expect(files.filter(([, c]) => /["'`]message\.dispatch["'`]/.test(c)).map(([f]) => f)).toEqual(["adapters/t3/ping.ts"]);
	});
	test("only ping.ts spawns the T3 CLI to send a message", () => {
		expect(files.filter(([, c]) => /["'`]thread["'`]\s*,\s*["'`]send["'`]/.test(c)).map(([f]) => f)).toEqual(["adapters/t3/ping.ts"]);
	});
});
