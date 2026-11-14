/** One server's watcher, first layer: its thread table, connection state and the reads of a thread. */
import type { Adapter, ThreadState } from "./adapter.ts";
import { has } from "./adapter-conformance.ts";
import type { Inspector } from "./adapter-inspect.ts";
import { isWaitingRead, type WaitingRead } from "./adapter-waiting.ts";
import { idleKey, idleWorkLine, principalWroteWithin, stewardInstruction } from "./decide.ts";
import type { Core } from "./engine.ts";
import { clip, NO_HISTORY } from "./engine-support.ts";
import { failedRead, type InstructionRead } from "./history.ts";
import type { IdleThreadSource } from "./idle-select.ts";
import type { Log } from "./log.ts";
import type { ServerEntry } from "./servers.ts";
import { BUSY_TURNS, type BusyFact, commitsAhead, SWEEP_MS } from "./sweep.ts";

/** One configured server's thread table, debounce timers, connection and resume state. */
export class WatcherReads {
	states = new Map<string, ThreadState>();
	timers = new Map<string, ReturnType<typeof setTimeout>>();
	connected = false;
	/** Counts every change of `connected`: a read whose epoch moved while it was out spanned a disconnect, so it is not believed. */
	epoch = 0;
	version: string | undefined;
	lastOk = Date.now();
	lastEventAt = 0;
	quietUntil = new Map<string, number>();
	turnStarts = new Map<string, { title: string; turns: number }>();
	/** Every card seen on a thread, and those already open when its current turn began. */
	cardsSeen = new Map<string, Set<string>>();
	oldCards = new Map<string, Set<string>>();
	/** Card items the adapter skipped, already logged: one line per thread and reason. */
	ignoredLogged = new Set<string>();
	/** A note recovery asks the next failed wake of a thread to carry, when its retry could not be made. */
	forced = new Map<string, string>();
	protected readonly inspect: Inspector | undefined;
	constructor(
		protected readonly core: Core,
		public srv: ServerEntry,
		public adapter: Adapter,
	) {
		this.inspect = has(adapter, "inspect") ? adapter.inspect : undefined;
	}

	protected get log(): Log {
		return this.core.log;
	}

	/** Busy threads, less the ones the principal is driving. If a thread can't be read it stays listed: a runaway must not hide behind a failed read. */
	async runawayCandidates(now: number): Promise<BusyFact[]> {
		const busy = this.takeBusy();
		const keep = await Promise.all(
			busy.map(async (b) => !principalWroteWithin((await this.instructionRead(b.id)).items, now, SWEEP_MS)),
		);
		return busy.filter((_, i) => keep[i]);
	}

	/** This server as a source of threads for the idle-parents selection (src/core/idle-parents.ts). */
	idleSource(): IdleThreadSource {
		const inspect = this.inspect;
		const lastAssistant = inspect?.lastAssistant;
		return {
			server: this.srv.name,
			connected: this.connected,
			threads: this.states.values(),
			liveChildren: (id) => this.liveChildren(id),
			...(inspect ? { runningSubagents: (id: string) => inspect.runningSubagents(id) } : {}),
			...(lastAssistant ? { lastAssistant: (id: string) => lastAssistant.call(inspect, id) } : {}),
			readFailed: (threadId, e) =>
				this.log("read-failed", {
					server: this.srv.name,
					threadId,
					what: "last assistant message",
					error: String(e).slice(0, 200),
				}),
		};
	}

	/** A thread running away keeps taking turns of its own. Counted at the turn's end, when who started it can be read. A machine's turn isn't one. */
	countTurn(th: ThreadState, read: InstructionRead) {
		if (read.byMachine || th.parentThreadId !== null) return;
		const seen = this.turnStarts.get(th.id);
		this.turnStarts.set(th.id, { title: th.title, turns: (seen?.turns ?? 0) + 1 });
	}

	/** Threads that kept starting turns since the last call: the cheap stand-in for counting fix rounds. */
	takeBusy(): BusyFact[] {
		const busy = [...this.turnStarts]
			.filter(([, v]) => v.turns >= BUSY_TURNS)
			.map(([id, v]) => ({ server: this.srv.name, id, title: clip(v.title, 80), turns: v.turns }));
		this.turnStarts.clear();
		return busy;
	}

	/** Health facts the heartbeat reports and alarms on. */
	health() {
		return {
			name: this.srv.name,
			version: this.version ?? null,
			connected: this.connected,
			downMs: this.connected ? 0 : Date.now() - this.lastOk,
			lastEventAt: this.lastEventAt ? new Date(this.lastEventAt).toISOString() : null,
			threads: this.states.size,
		};
	}

	/** The thread's latest instruction. A bad read is logged here and says so in its state. An adapter with no history reports none, cleanly. */
	async instructionRead(threadId: string): Promise<InstructionRead> {
		const read = this.inspect
			? await this.inspect.instruction(threadId).catch((e) => failedRead(String(e).slice(0, 200)))
			: NO_HISTORY;
		if (read.state !== "complete")
			this.log("instruction-read", { server: this.srv.name, threadId, state: read.state, error: read.error });
		return read;
	}

	/** Logs a read that failed before its fallback hides it. */
	readFailed<T>(what: string, threadId: string, fallback: T) {
		return (e: unknown) => {
			this.log("read-failed", { server: this.srv.name, threadId, what, error: String(e).slice(0, 200) });
			return fallback;
		};
	}

	protected lastMessage = (threadId: string) =>
		this.inspect ? this.inspect.lastMessage(threadId) : Promise.resolve("");
	subagents = (threadId: string) => (this.inspect ? this.inspect.runningSubagents(threadId) : Promise.resolve(0));

	/** A card item the adapter skipped is never evidence; it is logged once per thread and reason. */
	protected logIgnoredCards(threadId: string, ignored: string[]) {
		for (const why of ignored) {
			const k = `${threadId}\0${why}`;
			if (this.ignoredLogged.has(k)) continue;
			if (this.ignoredLogged.size > 1000) this.ignoredLogged.clear();
			this.ignoredLogged.add(k);
			this.log("card-item-ignored", { server: this.srv.name, threadId, reason: clip(why, 200) });
		}
	}

	/**
	 * What a thread waits on, as a `WaitingRead`. Only `ok: true` is a listing: a thrown read, an answer that breaks the contract,
	 * or a read that spanned a disconnect is `ok: false`. An adapter with no `inspect` lists nothing, and says so as `ok: true`
	 * (the needs-input path then wakes on the thread's own status; the card reconciler never reads through this).
	 */
	waitingRead = async (threadId: string): Promise<WaitingRead> => {
		if (!this.inspect) return { ok: true, cards: [] };
		if (!this.connected) return { ok: false, reason: `${this.srv.name} is not connected` };
		const epoch = this.epoch;
		const r: unknown = await this.inspect
			.waiting(threadId)
			.catch((e: unknown) => ({ ok: false, reason: String(e instanceof Error ? e.message : e).slice(0, 200) }));
		if (!isWaitingRead(r))
			return { ok: false, reason: "the adapter's waiting read did not keep the WaitingRead contract" };
		if (r.ok && (!this.connected || this.epoch !== epoch))
			return { ok: false, reason: `${this.srv.name} disconnected during the read` };
		this.logIgnoredCards(threadId, r.ok ? (r.ignored ?? []) : []);
		return r;
	};

	/** A thread that went idle with open work: an open PR, or commits on its branch that have not merged. */
	async idleWork(th: ThreadState, read: InstructionRead): Promise<{ key: string; work: string } | undefined> {
		// A machine's turn on the Steward's work has its one wake in reportKey. An idle wake would be a second.
		if (th.backgroundTasks > 0 || (read.byMachine && stewardInstruction(read.items))) return undefined;
		const key = idleKey(read.items, Date.now());
		if (!key || this.core.notified.has(key)) return undefined;
		if (th.openPrs.length) return { key, work: idleWorkLine(th.openPrs, 0) };
		if (!th.worktreePath || th.linkedPrDone) return undefined;
		const commits = await commitsAhead(this.srv.sshHost, th.worktreePath).catch((e) => {
			this.log("idle-check-failed", { server: this.srv.name, threadId: th.id, error: String(e).slice(0, 200) });
			return 0;
		});
		return commits > 0 ? { key, work: idleWorkLine([], commits) } : undefined;
	}

	/** Running children of a thread: their completion wakes the parent, so the parent is not idle. */
	liveChildren(parentId: string): number {
		let n = 0;
		for (const st of this.states.values())
			if (st.parentThreadId === parentId && ["running", "queued", "starting", "preparing"].includes(st.status)) n++;
		return n;
	}
}
