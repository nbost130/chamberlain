/**
 * The one way Chamberlain puts a message into a T3 thread. Every sender goes through this module: the decision-queue post
 * (the Decisions thread, over the T3 CLI), the page's direct send and goal acceptance, `t3x send`, and the daemon's own
 * stalled-thread retry (src/core/recover.ts). A second send path is a second place to get an identity, a seed or a timeout
 * wrong, so there is none: src/adapters/t3/ping.test.ts fails when another file builds a `message.dispatch` command.
 *
 * Two transports, one result shape:
 *   - `createRpcPing`: T3's `message.dispatch` over a server's RPC with its operate token. Steers a run that is going,
 *     or starts one. `seed` fixes the command and message IDs, so T3 drops a repeat of the same send.
 *   - `pingViaCli`: `t3 thread send <thread> -` on this machine, which needs no operate token (the Decisions thread).
 *
 * Who a message is signed as is a property of the send, named once here:
 *   steward   agent / mcp     the Steward's own relay. The thread's report-back wakes the Steward.
 *   daemon    agent / server  the daemon's own act (a retry). A machine delivery: it instructs nobody, so it never becomes
 *                             a thread's "latest instruction" and never reads as someone writing in the thread.
 *   operator  user / server   the principal's own accepted proposal (a /goal).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isPrivateFile } from "../../core/private.ts";
import { t3BaseDir } from "./settings.ts";
import { connect, type Rpc } from "./rpc.ts";
import type { T3Server } from "./server.ts";

export type Identity = "steward" | "daemon" | "operator";
export const IDENTITIES: Record<Identity, { createdBy: "agent" | "user"; creationSource: "mcp" | "server" }> = {
	steward: { createdBy: "agent", creationSource: "mcp" },
	daemon: { createdBy: "agent", creationSource: "server" },
	operator: { createdBy: "user", creationSource: "server" },
};
export type PingResult = { ok: boolean; detail: string };

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

export const redact = (msg: string, secrets: (string | undefined)[]) => secrets.reduce<string>((m, s) => (s ? m.split(s).join("[redacted]") : m), msg);

/** A token file in the config directory, or undefined: absent, not exactly 0600, or empty. */
export const readToken = (conf: string, file: string | null | undefined): string | undefined => {
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

export type MessageOptions = {
	threadId: string;
	text: string;
	/** Fixes the command and message IDs. Without one they are random: a send that must be safe to repeat gives a seed. */
	seed?: string;
	identity: Identity;
	/** The run a message steers. Without one, or with `start`, the message starts a run. */
	activeRunId?: string;
	start?: boolean;
};

/** Pure: the one `message.dispatch` command. This is the only place that builds it. */
export function messageCommand(o: MessageOptions): Record<string, unknown> {
	const who = IDENTITIES[o.identity];
	return {
		type: "message.dispatch",
		commandId: o.seed ? stableId(`cmd\0${o.seed}`) : crypto.randomUUID(),
		threadId: o.threadId,
		messageId: o.seed ? stableId(`msg\0${o.seed}`) : crypto.randomUUID(),
		text: o.text,
		attachments: [],
		createdBy: who.createdBy,
		creationSource: who.creationSource,
		dispatchMode: o.activeRunId && !o.start ? { type: "steer_active", targetRunId: o.activeRunId } : { type: "start_immediately" },
	};
}

/** The id of the run now going on a thread, from its projection's runs, or undefined. */
export const activeRunOf = (runs: { id?: string; status?: string }[] | undefined): string | undefined =>
	[...(runs ?? [])].reverse().find((r) => ["running", "waiting", "starting"].includes(String(r.status)))?.id;

/**
 * Pure: why a daemon ping must not go into this thread, from a projection read right now, or undefined when it may. The daemon only
 * ever starts a run on a thread whose newest run failed and which has nothing going and nothing waiting: it never steers a run and
 * never writes into a thread that waits on a card, approval or question.
 */
export function daemonPingRefusal(proj: { runs?: { id?: string; ordinal?: number; status?: string }[]; turnItems?: { status?: string }[] }): string | undefined {
	if (activeRunOf(proj.runs)) return "a run is active on the thread, and the daemon never steers one";
	if ((proj.turnItems ?? []).some((i) => i.status === "waiting")) return "the thread is waiting on a card, approval or question";
	const newest = [...(proj.runs ?? [])].reduce<{ status?: string; ordinal?: number } | undefined>((a, r) => (!a || (r.ordinal ?? -1) > (a.ordinal ?? -1) ? r : a), undefined);
	if (newest?.status !== "failed") return `the thread's newest run is ${newest?.status ?? "missing"}, not failed`;
	return undefined;
}

export type RpcPingDeps = {
	server: Pick<T3Server, "name" | "origin" | "operateTokenFile" | "tokenFile">;
	conf: string;
	connect?: (origin: string, token: string) => Promise<Pick<Rpc, "request"> & { ws: { close(): void } }>;
	/** Per-call deadline; tests shorten it. */
	timeoutMs?: number;
};

/** Opens a connection with a deadline. One that arrives after it is closed at once, so no socket or timer lingers. */
export function openWithin(conn: NonNullable<RpcPingDeps["connect"]>, origin: string, token: string, ms: number) {
	let late = false;
	const p = conn(origin, token);
	p.then((rpc) => { if (late) rpc.ws.close(); }, () => {});
	return within(p, ms, "connect").catch((e) => { late = true; throw e; });
}

/**
 * The server's ping: sends one message into a thread over its RPC with the server's operate token, steering a run that is
 * going or starting one. A server without an operate token is refused, and the caller falls back.
 */
export function createRpcPing(d: RpcPingDeps): (threadId: string, text: string, seed: string, identity?: Identity) => Promise<PingResult> {
	const conn = d.connect ?? (connect as unknown as NonNullable<RpcPingDeps["connect"]>);
	const ms = d.timeoutMs ?? CALL_TIMEOUT_MS;
	const s = d.server;
	return async (threadId, text, seed, identity = "steward") => {
		const token = readToken(d.conf, s.operateTokenFile);
		if (!token) return { ok: false, detail: `${s.name} has no operate token here, so the page can't send to its threads` };
		try {
			const rpc = await openWithin(conn, s.origin, token, ms);
			try {
				const proj = await within(rpc.request("orchestration.getThreadProjection", { threadId }), ms, "projection read") as { runs?: { id?: string; ordinal?: number; status?: string }[]; turnItems?: { status?: string }[] };
				const refused = identity === "daemon" ? daemonPingRefusal(proj) : undefined;
				if (refused) return { ok: false, detail: `not sent: ${refused}` };
				await within(rpc.request("orchestration.dispatchCommand", messageCommand({ threadId, text, seed, identity, activeRunId: activeRunOf(proj.runs) })), ms, "send");
				return { ok: true, detail: `sent to ${s.name}:${threadId}` };
			} finally {
				rpc.ws.close();
			}
		} catch (e) {
			return { ok: false, detail: redact(String(e), [token]).slice(0, 200) };
		}
	};
}

/** The T3 CLI: T3CODE_CLI_PATH, then <t3 base dir>/bin/t3, then the newest installed runtime. */
export function t3Cli(): string {
	if (process.env.T3CODE_CLI_PATH) return process.env.T3CODE_CLI_PATH;
	const base = t3BaseDir();
	if (existsSync(`${base}/bin/t3`)) return `${base}/bin/t3`;
	const root = `${base}/runtime/versions`;
	const vs = existsSync(root) ? readdirSync(root).filter((v) => existsSync(`${root}/${v}/t3`)).sort((a, b) => Bun.semver.order(a, b)) : [];
	if (!vs.length) throw Error("ask: no T3 CLI found (set T3CODE_CLI_PATH)");
	return `${root}/${vs.at(-1)}/t3`;
}

/** Sends one message to a thread with the T3 CLI on this machine. The text goes on stdin, never into a command line. */
export function pingViaCli(threadId: string, text: string, cli: () => string = t3Cli): PingResult {
	const r = Bun.spawnSync([cli(), "thread", "send", threadId, "-"], { stdin: Buffer.from(text), stdout: "pipe", stderr: "pipe", timeout: 60_000 });
	return { ok: r.exitCode === 0, detail: (r.stdout.toString() + r.stderr.toString()).trim().slice(0, 300) };
}
