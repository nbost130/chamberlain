/**
 * The adapter contract: everything Chamberlain needs from an agent backend, and nothing else.
 *
 * Chamberlain's core decides, holds, delivers and records; it never speaks a backend's protocol. A backend (T3 Code,
 * a terminal workspace manager, an in-memory fake for tests) is one folder under src/adapters/ that implements this
 * interface and is registered in src/adapters/index.ts. Code in src/core/ must not import from src/adapters/ (a test
 * enforces it), so this file is the whole seam.
 *
 * Four capabilities are required: `watch`, `wake`, `isBusy` and `post`. Everything else is optional, and an adapter
 * names the optional ones it has in `capabilities`. The core and the page degrade cleanly when one is missing:
 *
 *   - no `answer`          the page shows a waiting card read-only, with where to answer it
 *   - no `listWaiting`     the page has no mirror of waiting cards
 *   - no `setTitle`        there is no title keeper
 *   - no `send`            an option routed straight to a thread goes to the Steward instead
 *   - no `inspect`         a turn end wakes once per turn, with no excerpt, question or report gating
 *   - no `stewardProbe`    no stall alarm, no context-size tracking, no compaction
 *   - no `compact`         the daemon only alarms that the Steward is over its size
 *   - no `transcriptPath`  Steward health reports "unavailable"
 */
import type { Gate } from "./hold.ts";
import type { WakeTransport } from "./deliver.ts";
import type { InstructionRead } from "./history.ts";
import type { Question } from "./questions.ts";
import type { Store } from "./store.ts";
import type { ServerEntry } from "./servers.ts";

// ---- the normalized thread -----------------------------------------------------------------------

/**
 * One thread as the core reads it. `status` uses one vocabulary whatever the backend says: `running`, `queued`,
 * `starting`, `preparing`, `waiting` (blocked on the human), `completed`, `idle`, `interrupted`, `failed`. An adapter maps
 * its own states onto these. Everything past `status` is optional data a backend may or may not have; see `ThreadInput`.
 */
export type ThreadState = {
	id: string;
	title: string;
	status: string;
	parentThreadId: string | null;
	pendingRequestId: string | null;
	settled: boolean;
	archived: boolean;
	snoozed: boolean;
	blockedOnThreadWait: boolean;
	/** Numbers of the thread's pull requests that its backend last saw open. */
	openPrs: number[];
	worktreePath: string | null;
	/** A linked pull request has merged or closed. A squash merge leaves commits on the branch, and they are finished work. */
	linkedPrDone: boolean;
	backgroundTasks: number;
	/** Background work that is the thread's own. A watched PR counts as a task in T3, and it can wait for days. */
	backgroundWork: number;
	/** The id of the thread's newest run, when the backend names one. A failure is told apart from the last one by it (src/core/decide.ts). */
	latestRunId?: string | null;
};

/** What an adapter hands over: the three fields every backend has, and any of the rest it can fill in. */
export type ThreadInput = Pick<ThreadState, "id" | "title" | "status"> & Partial<Omit<ThreadState, "id" | "title" | "status">>;

/** Pure: a thread with every optional field given its neutral value (top-level, no request, nothing open). */
export const normalizeThread = (t: ThreadInput): ThreadState => ({
	id: t.id,
	title: t.title,
	status: t.status,
	parentThreadId: t.parentThreadId ?? null,
	pendingRequestId: t.pendingRequestId ?? null,
	settled: t.settled ?? false,
	archived: t.archived ?? false,
	snoozed: t.snoozed ?? false,
	blockedOnThreadWait: t.blockedOnThreadWait ?? false,
	openPrs: t.openPrs ?? [],
	worktreePath: t.worktreePath ?? null,
	linkedPrDone: t.linkedPrDone ?? false,
	backgroundTasks: t.backgroundTasks ?? 0,
	backgroundWork: t.backgroundWork ?? 0,
	latestRunId: t.latestRunId ?? null,
});

// ---- watch ---------------------------------------------------------------------------------------

/** The three things worth waking the Steward for. */
export type WakeKind = "needs_input" | "failed" | "turn_ended";

/**
 * What `watch` emits. Most backends report state changes and let the core's rules (src/core/decide.ts) find the events:
 * emit `{ kind: "state" }` for every sighting of a thread, the first one included (nothing fires on a first sighting
 * unless the thread already waits on a request). A backend that already knows what happened may emit the event itself.
 * Either way the core debounces, re-checks the newest state and applies its own gates before anything is sent.
 */
export type ThreadEvent =
	| { kind: "state"; thread: ThreadInput }
	| { kind: WakeKind; thread: ThreadInput };

/** What `watch` reports back to the core. */
export type WatchSink = {
	event(e: ThreadEvent): void;
	/** The connection to the backend came up or went down. `version` is whatever the backend calls its version. */
	connected(up: boolean, info?: { version?: string }): void;
	log(event: string, data?: Record<string, unknown>): void;
};

// ---- inspect -------------------------------------------------------------------------------------

/** The kinds of waiting item. An adapter maps its own names onto these (T3 calls a link request by several names). */
export type WaitKind = "user_input_request" | "approval_request" | "secret_request" | "link_request";
export type WaitQuestion = { question?: string; options?: { label?: string; description?: string }[] };
/** One thing a thread is waiting on: a question, an approval, a secret or a link request. */
export type WaitingItem = { type: WaitKind; requestId: string; label: string; questions: WaitQuestion[] };

/**
 * Reads of one thread, made on demand when a wake is being built. A read that fails rejects; the core logs it and carries
 * on with a neutral value (no excerpt, no question, no subagents). `instruction` never rejects: its state says what happened.
 */
/**
 * Why a run failed, as the backend records it. `class`, `code` and `message` are the backend's own words; src/core/recover.ts reads
 * them in code and never asks a model what kind of failure it was. `interrupted` is true when someone stopped the run: a stop is not an outage.
 */
export type RunFailure = { runId: string; class?: string; code?: string; message: string; retryable?: boolean; resetAt?: string; interrupted?: boolean };

export type Inspector = {
	/** The text of the thread's last finished assistant message, or "" when there is none or it can't be read. */
	lastMessage(threadId: string): Promise<string>;
	/** What the thread is waiting on now. */
	waiting(threadId: string): Promise<WaitingItem[]>;
	/** Subagents the thread itself runs (not separate threads): their completion wakes it. */
	runningSubagents(threadId: string): Promise<number>;
	/** The thread's latest instruction, past the backend's window if need be (src/core/history.ts says what the state means). */
	instruction(threadId: string): Promise<InstructionRead>;
	/** The newest failed run of the thread and its error. Absent: the adapter cannot say, and stalled-thread recovery stays off for its threads. */
	failure?(threadId: string): Promise<RunFailure | undefined>;
};

// ---- post ----------------------------------------------------------------------------------------

export type PostOptions = {
	/** The decision-queue page's base URL, when the page answers right now. Absent: post a plain notice. */
	queueUrl?: string;
};
export type PostResult = { ok: boolean; detail: string; where: "view" | "notice" };

// ---- the page's waiting cards --------------------------------------------------------------------

/** A question, approval, secret, link request or goal proposal waiting on the operator in some thread. */
export type WaitingCard = {
	id: string;
	/** A question card, or one of the kinds that are only ever shown. */
	type: "question" | "approval" | "secret" | "link" | "goal";
	server: string;
	threadId: string;
	threadTitle: string;
	requestId: string;
	header?: string;
	question: string;
	options: { label: string; detail?: string }[];
	recommended?: number;
	/** True when the operator can answer it from the page; otherwise `why` says where to answer it. */
	answerable: boolean;
	why?: string;
	link?: string;
	/** An approval's command, or a proposal's text, exactly as the backend holds it (shown verbatim, never reflowed). */
	command?: string;
	/** Fingerprint of the card exactly as the backend holds it. An answer must carry the one the operator saw. */
	sig: string;
};

export type ListWaitingOptions = {
	/** Threads never listed (the Decisions thread). */
	skipThreads: string[];
	/** Prefix a thread id is appended to for an "open in the backend" link. */
	linkBase?: string;
};

/**
 * How an answer to a card ended. `stale`: the card changed or went away before anything was sent. `refused`: this
 * adapter may not answer (no rights). `unreachable`: the backend could not be reached or did not reply. `maybeSent`
 * means the answer may have reached the backend even though this call failed, so the core never sends it again.
 * `gone` means the card is no longer waiting, so the core drops it from its list.
 */
export type AnswerOutcome =
	| { ok: true; choice: string }
	| { ok: false; kind: "stale" | "refused" | "unreachable"; error: string; maybeSent: boolean; gone?: boolean };

// ---- the steward ---------------------------------------------------------------------------------

/** What an adapter can tell about the Steward's own thread, read once a minute. */
export type StewardProbe = {
	/** The Steward's context size in tokens, when known. */
	contextTokens?: number;
	/** False when the backend's own record of the Steward could not be read this time. */
	readable: boolean;
	/** Set when wakes are queued and nothing in the Steward's thread has moved: the alarm to raise. */
	stalled?: { title: string; summary: string };
	/** Why a compaction must not be sent now, or undefined when one may go. */
	compactBlocked?: string;
};

/** A transcript the health check can measure: Claude Code's JSONL for the Steward's session. */
export type Transcript = {
	path: string;
	session: string;
	thread: string;
	/** Names a tool call that reads another thread by the thread it reads (see MeasureOptions in steward-health.ts). */
	threadReadKey?: (tool: string, input: Record<string, any>) => string | undefined;
};

// ---- the adapter ---------------------------------------------------------------------------------

export type OptionalCapability = "answer" | "listWaiting" | "setTitle" | "transcriptPath" | "inspect" | "send" | "stewardProbe" | "compact";

export interface Adapter {
	/** The registry name: "t3", "fake". */
	readonly id: string;
	/** The optional capabilities this adapter implements. A named capability has its method; no other does. */
	readonly capabilities: readonly OptionalCapability[];

	// -- required --

	/** Watches the backend and reports threads through `sink` until `signal` aborts. Owns its own reconnecting. */
	watch(sink: WatchSink, signal: AbortSignal): Promise<void>;
	/** How a wake reaches the Steward. Delivery (src/core/deliver.ts) owns retries, the outbox and the ledger. */
	readonly wake: WakeTransport;
	/** Does the Steward have a turn running or queued? "unknown" when it can't be told. Synchronous: answer from what you know. */
	isBusy(): Gate;
	/** Shows one decision-queue question where the operator is. The item is already on the page; a failed post leaves it there. */
	post(item: Question, opts: PostOptions): Promise<PostResult>;

	// -- optional --

	/** Respond to a waiting card with one of its options, after re-reading it live. Never answers a secret or link request. */
	answer?(card: WaitingCard, choice: number, sig: string): Promise<AnswerOutcome>;
	/** Everything waiting on the operator on this adapter's server. Throws when the server can't be read. */
	listWaiting?(opts: ListWaitingOptions): Promise<WaitingCard[]>;
	/** Names the Decisions thread: "Decisions · 2 waiting". */
	setTitle?(title: string): Promise<"set" | "no-token" | "failed">;
	/** Where the Steward's transcript is, for the health check. */
	transcriptPath?(): Promise<Transcript>;
	/** Reads of one thread, for building a wake. */
	readonly inspect?: Inspector;
	/** Sends a message into a thread, once for one `seed`: the daemon's one ping. Signed as the Steward unless `identity` says otherwise ("daemon": its own retry, which instructs nobody). Used for an option routed straight to its thread and for stalled-thread recovery. */
	send?(threadId: string, text: string, seed: string, identity?: "steward" | "daemon" | "operator"): Promise<{ ok: boolean; detail: string }>;
	/** The Steward's size, stall and compaction state. */
	stewardProbe?(): StewardProbe;
	/** How a compaction request reaches the Steward. Its `send` takes no message. */
	readonly compact?: WakeTransport;

	// -- wording --

	/** The wake's server line: how the woken thread reaches this server with its own tools. */
	serverLine?(): string;
	/** One sentence added to an approval wake, naming what cannot answer it. */
	readonly approvalHint?: string;
}

/** What the core hands an adapter when it creates one for a server. */
export type AdapterEnv = {
	/** The servers.json entry this adapter serves, with any answer rights the page granted it. */
	server: ServerEntry;
	conf: string;
	state: string;
	/** The database, for an adapter that must remember something across a restart: keep it under your own source name. Absent in tests that need none. */
	store?: Store;
	log: (event: string, data?: Record<string, unknown>) => void;
	/** Raise a dead-man alarm (deduplicated by key, at most once per six hours). */
	alarm: (key: string, title: string, summary: string) => void;
	/** The Steward's thread id, read fresh: it changes when the Steward is handed off. */
	steward: () => string | undefined;
	/** The contents of a private (mode 0600) file in the config directory, trimmed, or undefined when it is not there. */
	readPrivate: (name: string) => string | undefined;
};
export type AdapterFactory = (env: AdapterEnv) => Adapter;

/**
 * The adapter-specific sentences of the Steward's hand-off (src/core/brief.ts): what it calls its threads and servers, and
 * how it reads a thread or reaches a server with the backend's own tools. Every field has a neutral default.
 */
export type BriefNotes = {
	/** What the Steward calls the threads it runs: "T3 threads". Default "agent threads". */
	threads?: string;
	/** What it calls the servers the daemon watches: "T3 server". Default "server". */
	server?: string;
	/** How to read the end of a thread cheaply, finishing the sentence "Otherwise ...". */
	readThread?: string;
	/** Extra sentences for the "context is the budget" bullet. */
	contextExtras?: string;
	/** A clause ending the "never answer a card meant for them" bullet, such as naming a tool that stays off it. */
	cardGuard?: string;
	/** The line above the list of servers under "Reach". */
	reachIntro?: string;
	/** A paragraph below the list: a fallback command line, for example. */
	reachOutro?: string;
};

/** A registry entry: how to make the adapter, and the lines of the Steward's hand-off that are about its backend. */
export type AdapterEntry = { create: AdapterFactory; brief?: (ctx: { repo: string }) => BriefNotes };

/** True when the adapter declares the capability. The type guard says which method is then present. */
export function has<K extends OptionalCapability>(a: Adapter, cap: K): a is Adapter & Required<Pick<Adapter, CapabilityMethod[K]>> {
	return a.capabilities.includes(cap);
}
type CapabilityMethod = { answer: "answer"; listWaiting: "listWaiting"; setTitle: "setTitle"; transcriptPath: "transcriptPath"; inspect: "inspect"; send: "send"; stewardProbe: "stewardProbe"; compact: "compact" };

/** Pure: what is wrong with an adapter's declaration, or an empty list. Every adapter test (and the fake's) runs it. */
export function conformance(a: Adapter): string[] {
	const bad: string[] = [];
	if (!a.id) bad.push("no id");
	for (const m of ["watch", "isBusy", "post"] as const) if (typeof a[m] !== "function") bad.push(`required method ${m} is missing`);
	if (!a.wake || typeof a.wake.ready !== "function" || typeof a.wake.send !== "function") bad.push("required capability wake needs ready() and send()");
	const methods: Record<OptionalCapability, unknown> = { answer: a.answer, listWaiting: a.listWaiting, setTitle: a.setTitle, transcriptPath: a.transcriptPath, inspect: a.inspect, send: a.send, stewardProbe: a.stewardProbe, compact: a.compact };
	for (const [cap, impl] of Object.entries(methods)) {
		const declared = a.capabilities.includes(cap as OptionalCapability);
		if (declared && !impl) bad.push(`declares ${cap} but does not implement it`);
		if (!declared && impl) bad.push(`implements ${cap} but does not declare it`);
	}
	for (const cap of a.capabilities) if (!(cap in methods)) bad.push(`declares unknown capability ${cap}`);
	return bad;
}
