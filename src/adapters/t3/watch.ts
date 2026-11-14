/**
 * The T3 adapter's `watch` and its thread reads: one authenticated socket to the T3 server with a read-only token,
 * subscribed to the shell stream, reconnecting with backoff and resuming from the last sequence it saw. Every thread
 * record becomes a normalized state for the core; the same socket serves the on-demand reads (`inspect`).
 */
import { statSync } from "node:fs";
import type { AdapterEnv, Inspector, RunFailure, ThreadSnapshot, WaitingRead, WatchSink } from "../../core/adapter.ts";
import { failedRead } from "../../core/history.ts";
import { SECRETS_DIR, secretPath } from "../../core/layout.ts";
import { alarms } from "../../core/messages.ts";
import { compatWarning, readEnvironment, T3_TESTED } from "./compat.ts";
import { failureOf, lookOf } from "./failure.ts";
import { historyGet, readWhenConnected } from "./history.ts";
import { checkProjection, isObject, type Projection, readCards } from "./projection.ts";
import { connect, fetchShellSnapshot, type Rpc } from "./rpc.ts";
import type { T3Server } from "./server.ts";
import { toState } from "./state.ts";

const TOKEN_MAX_AGE_DAYS = 25;

export class T3Link {
	rpc: Rpc | undefined;
	private compatChecked = false;
	constructor(
		private env: AdapterEnv,
		private srv: T3Server,
	) {}

	private token() {
		return this.env.readPrivate(this.srv.tokenFile);
	}

	/** The T3 server's version, checked once per process. Outside the tested range is a warning only: the watcher keeps running. */
	private async checkCompat(sink: WatchSink) {
		if (this.compatChecked) return;
		this.compatChecked = true;
		const env = await readEnvironment(this.srv.origin);
		const version = typeof env?.serverVersion === "string" ? env.serverVersion : undefined;
		const warning = compatWarning(env);
		if (warning) {
			sink.log("compat-warning", {
				server: this.srv.name,
				t3Version: version ?? null,
				tested: `${T3_TESTED.min} to ${T3_TESTED.max}`,
				warning,
			});
			console.warn(`chamberlain: ${this.srv.name}: ${warning}`);
		} else sink.log("compat-ok", { server: this.srv.name, t3Version: version });
		if (this.rpc) sink.connected(true, { version });
	}

	/** A read token older than TOKEN_MAX_AGE_DAYS is about to lapse (they last 30): alarm so a new one is minted first. */
	private checkTokenAge() {
		try {
			// The token's own file: `secrets/<name>` (a migration renames it there and keeps its date), else the old place of one never migrated.
			const path = secretPath(this.env.conf, this.srv.tokenFile);
			if (!path) return;
			const ageDays = (Date.now() - statSync(path).mtimeMs) / 86_400_000;
			if (ageDays > TOKEN_MAX_AGE_DAYS) {
				const shown = path.startsWith(`${this.env.conf}/${SECRETS_DIR}/`)
					? `${SECRETS_DIR}/${this.srv.tokenFile}`
					: this.srv.tokenFile;
				const a = alarms.tokenExpiring(this.srv.name, Math.round(ageDays), shown);
				this.env.alarm(`token:${this.srv.name}`, a.title, a.summary);
			}
		} catch {
			/* a missing file already fails the session loudly */
		}
	}

	private async session(
		sink: WatchSink,
		signal: AbortSignal,
		afterSequence: number | undefined,
	): Promise<number | undefined> {
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
		conn
			.call("orchestration.subscribeShell", seq === undefined ? {} : { afterSequence: seq }, (v) => {
				if (v.kind === "snapshot" && v.snapshot) {
					seq = v.snapshot.snapshotSequence ?? seq;
					for (const th of v.snapshot.threads ?? []) sink.event({ kind: "state", thread: toState(th) });
				} else if (v.kind === "thread.updated" && v.thread) {
					if (typeof v.sequence === "number") seq = v.sequence;
					sink.event({ kind: "state", thread: toState(v.thread) });
				}
			})
			.then(
				() => conn.ws.close(),
				() => conn.ws.close(),
			);
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

	/**
	 * A fresh read of every thread, over a socket of its own. Rejects when the server can't be reached or says the snapshot is
	 * partial. It is NEVER `complete`: T3's shell stream gives no positive proof that a snapshot lists every thread, so a thread
	 * missing from it, or marked archived, is not evidence that the thread is gone, and nothing closes on it.
	 */
	async snapshot(): Promise<ThreadSnapshot> {
		const token = this.token();
		if (!token) throw Error(`no ${this.srv.tokenFile}`);
		const { threads } = await fetchShellSnapshot(this.srv.origin, token);
		// A record with no id is left out, not fatal: the snapshot is never complete, so a missing record is never read as anything,
		// and a snapshot that answered keeps a hold that names no server unknown (hold-reconcile.ts threadViewAcross).
		const readable = threads.filter(
			(th) => isObject(th) && (typeof th.id === "string" || typeof th.id === "number") && String(th.id) !== "",
		);
		return {
			complete: false,
			threads: readable.map((th) => {
				const t = toState(th);
				return {
					id: t.id,
					archived: t.archived,
					settled: t.settled,
					pendingRequestId: t.pendingRequestId,
					status: t.status,
				};
			}),
		};
	}

	/** One thread's projection over the watcher's socket, checked against the shape the reads expect: anything else throws. */
	private async projection(threadId: string): Promise<Projection> {
		const rpc = this.rpc;
		if (!rpc) throw Error(`${this.srv.name} is not connected: a projection is read only over a live socket`);
		return checkProjection(await rpc.request("orchestration.getThreadProjection", { threadId }));
	}

	readonly inspector: Inspector = {
		lastMessage: async (threadId) => {
			if (!this.rpc) return "";
			const p = await this.projection(threadId);
			const last = [...(p.turnItems ?? [])]
				.reverse()
				.find((i) => i.type === "assistant_message" && i.status === "completed");
			return String(last?.text ?? "");
		},
		lastAssistant: async (threadId) => {
			if (!this.rpc) return undefined;
			const p = await this.projection(threadId);
			const items = p.turnItems ?? [];
			const last = [...items].reverse().find((i) => i.type === "assistant_message" && i.status === "completed");
			const id = last?.itemId ?? last?.id;
			if (!last || typeof id !== "string" || typeof last.updatedAt !== "string") return undefined;
			// The user message before it, and who wrote it: T3 marks the operator's own messages createdBy "user".
			const before = items
				.slice(0, items.lastIndexOf(last))
				.reverse()
				.find((i) => i.type === "user_message" && String(i.text ?? "").trim());
			return {
				id,
				text: String(last.text ?? ""),
				at: last.updatedAt,
				...(before
					? { previous: { by: before.createdBy === "user" ? "human" : "agent", text: String(before.text) } }
					: {}),
			};
		},
		runningSubagents: async (threadId) => {
			if (!this.rpc) return 0;
			const p = await this.projection(threadId);
			return (p.subagents ?? []).filter((x) => ["running", "starting", "queued"].includes(String(x.status))).length;
		},
		/**
		 * The thread's cards, from its projection (a bounded window of its history): those waiting, and the request IDs of those
		 * seen resolved. `ok: true` only when the socket was up for the whole read and the projection had the expected shape.
		 */
		waiting: async (threadId): Promise<WaitingRead> => {
			const rpc = this.rpc;
			if (!rpc) return { ok: false, reason: `${this.srv.name} is not connected` };
			try {
				const read = waitingOf(await rpc.request("orchestration.getThreadProjection", { threadId }), threadId);
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
		instruction: (threadId) =>
			readWhenConnected(
				Boolean(this.rpc),
				threadId,
				historyGet(this.srv.origin, () => this.token()),
			).catch((e) => failedRead(String(e).slice(0, 200))),
	};
}

/**
 * Pure: a projection read as a `WaitingRead`. A projection in any other shape is `ok: false`; otherwise its card items are read
 * one by one (`readCards`). The projection is a bounded window of the thread's history, so the read lists what it SAW, never
 * everything the thread waits on.
 */
export function waitingOf(raw: unknown, threadId: string): WaitingRead {
	let p: Projection;
	try {
		p = checkProjection(raw);
	} catch (e) {
		return { ok: false, reason: (e as Error).message };
	}
	return readCards(p.turnItems, threadId);
}
