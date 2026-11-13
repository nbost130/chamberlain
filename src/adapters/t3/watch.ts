/**
 * The T3 adapter's `watch` and its thread reads: one authenticated socket to the T3 server with a read-only token,
 * subscribed to the shell stream, reconnecting with backoff and resuming from the last sequence it saw. Every thread
 * record becomes a normalized state for the core; the same socket serves the on-demand reads (`inspect`).
 */
import { statSync } from "node:fs";
import type { AdapterEnv, Inspector, RunFailure, WaitingItem, WaitingRead, WaitQuestion, WatchSink } from "../../core/adapter.ts";
import { OPERATOR_ONLY_KINDS } from "../../core/decide.ts";
import { failedRead } from "../../core/history.ts";
import { compatWarning, readEnvironment, T3_TESTED } from "./compat.ts";
import { historyGet, readWhenConnected } from "./history.ts";
import { connect, fetchShellSnapshot, type Rpc } from "./rpc.ts";
import type { ThreadSnapshot } from "../../core/adapter.ts";
import type { T3Server } from "./server.ts";
import { normalizeWaitKind, toState } from "./state.ts";
import { failureOf, lookOf } from "./failure.ts";
import { checkProjection, isObject, type Projection } from "./projection.ts";

const TOKEN_MAX_AGE_DAYS = 25;

export class T3Link {
	rpc: Rpc | undefined;
	private compatChecked = false;
	constructor(private env: AdapterEnv, private srv: T3Server) {}

	private token() { return this.env.readPrivate(this.srv.tokenFile); }

	/** The T3 server's version, checked once per process. Outside the tested range is a warning only: the watcher keeps running. */
	private async checkCompat(sink: WatchSink) {
		if (this.compatChecked) return;
		this.compatChecked = true;
		const env = await readEnvironment(this.srv.origin);
		const version = typeof env?.serverVersion === "string" ? env.serverVersion : undefined;
		const warning = compatWarning(env);
		if (warning) {
			sink.log("compat-warning", { server: this.srv.name, t3Version: version ?? null, tested: `${T3_TESTED.min} to ${T3_TESTED.max}`, warning });
			console.warn(`chamberlain: ${this.srv.name}: ${warning}`);
		} else sink.log("compat-ok", { server: this.srv.name, t3Version: version });
		if (this.rpc) sink.connected(true, { version });
	}

	/** A read token older than TOKEN_MAX_AGE_DAYS is about to lapse (they last 30): alarm so a new one is minted first. */
	private checkTokenAge() {
		try {
			const ageDays = (Date.now() - statSync(`${this.env.conf}/${this.srv.tokenFile}`).mtimeMs) / 86_400_000;
			if (ageDays > TOKEN_MAX_AGE_DAYS) this.env.alarm(`token:${this.srv.name}`, `chamberlain token for ${this.srv.name} expires soon`, `The ${this.srv.name} read token is ${Math.round(ageDays)} days old and tokens last 30 days. Mint a new one into ${this.srv.tokenFile} before it lapses, or the watcher goes blind there.`);
		} catch { /* a missing file already fails the session loudly */ }
	}

	private async session(sink: WatchSink, signal: AbortSignal, afterSequence: number | undefined): Promise<number | undefined> {
		const token = this.token();
		if (!token) throw Error(`no ${this.srv.tokenFile}`);
		const conn = await connect(this.srv.origin, token);
		const onAbort = () => conn.ws.close();
		signal.addEventListener("abort", onAbort, { once: true });
		this.rpc = conn;
		sink.connected(true);
		void this.checkCompat(sink);
		let seq = afterSequence;
		sink.log("connected", { server: this.srv.name, resumeFrom: seq ?? null });
		conn.call("orchestration.subscribeShell", seq === undefined ? {} : { afterSequence: seq }, (v) => {
			if (v.kind === "snapshot" && v.snapshot) {
				seq = v.snapshot.snapshotSequence ?? seq;
				for (const th of v.snapshot.threads ?? []) sink.event({ kind: "state", thread: toState(th) });
			} else if (v.kind === "thread.updated" && v.thread) {
				if (typeof v.sequence === "number") seq = v.sequence;
				sink.event({ kind: "state", thread: toState(v.thread) });
			}
		}).then(() => conn.ws.close(), () => conn.ws.close());
		await conn.closed;
		signal.removeEventListener("abort", onAbort);
		conn.fail();
		this.rpc = undefined;
		sink.connected(false);
		sink.log("disconnected", { server: this.srv.name });
		return seq;
	}

	async watch(sink: WatchSink, signal: AbortSignal) {
		const timer = setInterval(() => this.checkTokenAge(), 60_000);
		let seq: number | undefined;
		let delay = 500;
		try {
			while (!signal.aborted) {
				try {
					const before = Date.now();
					seq = await this.session(sink, signal, seq);
					if (Date.now() - before > 30000) delay = 500;
				} catch (e) {
					sink.log("session-error", { server: this.srv.name, error: e instanceof Error ? e.message : String(e) });
				}
				if (signal.aborted) break;
				await Bun.sleep(delay + Math.random() * delay * 0.2);
				delay = Math.min(30000, delay * 2);
			}
		} finally {
			clearInterval(timer);
		}
	}

	/** A fresh read of every thread, over a socket of its own. Rejects when the server can't be reached. */
	async snapshot(): Promise<ThreadSnapshot> {
		const token = this.token();
		if (!token) throw Error(`no ${this.srv.tokenFile}`);
		const { threads } = await fetchShellSnapshot(this.srv.origin, token);
		// A thread with no id would read as every other thread missing from it: the whole snapshot is refused instead.
		if (!threads.every((th) => isObject(th) && (typeof th.id === "string" || typeof th.id === "number") && String(th.id) !== "")) throw Error("malformed snapshot: a thread has no id");
		return { complete: true, threads: threads.map((th) => { const t = toState(th); return { id: t.id, archived: t.archived, settled: t.settled, pendingRequestId: t.pendingRequestId, status: t.status }; }) };
	}

	/** One thread's projection over the watcher's socket, checked against the shape the reads expect: anything else throws. */
	private async projection(threadId: string): Promise<Projection> {
		return checkProjection(await this.rpc!.request("orchestration.getThreadProjection", { threadId }));
	}

	readonly inspector: Inspector = {
		lastMessage: async (threadId) => {
			if (!this.rpc) return "";
			const p = await this.projection(threadId);
			const last = [...(p.turnItems ?? [])].reverse().find((i) => i.type === "assistant_message" && i.status === "completed");
			return String(last?.text ?? "");
		},
		runningSubagents: async (threadId) => {
			if (!this.rpc) return 0;
			const p = await this.projection(threadId);
			return (p.subagents ?? []).filter((x) => ["running", "starting", "queued"].includes(String(x.status))).length;
		},
		/**
		 * What the thread is waiting on, from its projection: kind and request id of each waiting item. Authoritative (`ok: true`)
		 * only when the socket was up for the whole read and the projection had exactly the expected shape (`WaitingRead`).
		 */
		waiting: async (threadId): Promise<WaitingRead> => {
			const rpc = this.rpc;
			if (!rpc) return { ok: false, reason: `${this.srv.name} is not connected` };
			const at = Date.now();
			try {
				const read = waitingOf(await rpc.request("orchestration.getThreadProjection", { threadId }), at);
				// The socket dropped or was replaced while the read was out: what came back cannot be told from a stale answer.
				if (this.rpc !== rpc) return { ok: false, reason: `${this.srv.name} disconnected during the read` };
				return read;
			} catch (e) {
				return { ok: false, reason: String(e instanceof Error ? e.message : e).slice(0, 200) };
			}
		},
		/** The thread's latest instruction, past T3's window if it has to be. HTTP can work while the socket is down, and then the state is stale, so no socket is a failed read. */
		/** The thread's newest failed run and the error T3 recorded for it (src/adapters/t3/failure.ts). */
		failure: async (threadId): Promise<RunFailure | undefined> => {
			if (!this.rpc) return undefined;
			const p = await this.projection(threadId);
			return failureOf(p.runs ?? [], p.turnItems ?? []);
		},
		/** The projection read again, for the moment before a ping: the newest run, whether any run is going, whether any card is open. */
		look: async (threadId) => {
			if (!this.rpc) return undefined;
			const p = await this.projection(threadId);
			return lookOf(p.runs ?? [], p.turnItems ?? []);
		},
		instruction: (threadId) => readWhenConnected(Boolean(this.rpc), threadId, historyGet(this.srv.origin, () => this.token())).catch((e) => failedRead(String(e).slice(0, 200))),
	};
}

/**
 * Pure: a projection read as a `WaitingRead`. Any shape this does not expect, including a waiting item with no request id
 * or with questions that are not a list, is `ok: false`, never an empty listing.
 */
export function waitingOf(raw: unknown, at: number): WaitingRead {
	let p: Projection;
	try { p = checkProjection(raw); } catch (e) { return { ok: false, reason: (e as Error).message }; }
	const cards: WaitingItem[] = [];
	for (const i of p.turnItems) {
		if (i.status !== "waiting") continue;
		if (typeof i.type !== "string") return { ok: false, reason: "malformed projection: a waiting item has no type" };
		if (!(i.type === "user_input_request" || OPERATOR_ONLY_KINDS.has(normalizeWaitKind(i.type)))) continue;
		const id = i.requestId ?? i.id;
		if ((typeof id !== "string" && typeof id !== "number") || String(id) === "") return { ok: false, reason: "malformed projection: a waiting item has no request id" };
		if (i.questions !== undefined && !Array.isArray(i.questions)) return { ok: false, reason: "malformed projection: a waiting item's questions are not a list" };
		cards.push({ type: normalizeWaitKind(i.type) as WaitingItem["type"], requestId: String(id), label: String(i.label ?? i.prompt ?? i.questions?.[0]?.header ?? ""), questions: (i.questions ?? []) as WaitQuestion[] });
	}
	return { ok: true, cards, at };
}
