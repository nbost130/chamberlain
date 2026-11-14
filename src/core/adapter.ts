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
 *   - no `alertDesk`       alerts are not routed to a desk thread: the inbox is never drained
 *   - no `handoffInstruction`  a HAND OFF verdict is put to the operator as a question; the daemon does not start the hand-off itself
 *   - no `transcriptPath`  Steward health reports "unavailable"
 *   - no `threadLinks`     a card links to its thread only where the page's config names a link prefix for its server
 */

import type { Inspector, StewardProbe, ThreadSnapshot, Transcript } from "./adapter-inspect.ts";
import type { AnswerOutcome, ListWaitingOptions, ThreadLinks, WaitingCard } from "./adapter-waiting.ts";
import type { WakeTransport } from "./deliver.ts";
import type { Gate } from "./hold.ts";
import type { Question } from "./questions.ts";
import type { ServerEntry } from "./servers.ts";
import type { Store } from "./store.ts";

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
export type ThreadInput = Pick<ThreadState, "id" | "title" | "status"> &
	Partial<Omit<ThreadState, "id" | "title" | "status">>;

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
export type ThreadEvent = { kind: "state"; thread: ThreadInput } | { kind: WakeKind; thread: ThreadInput };

/** What `watch` reports back to the core. */
export type WatchSink = {
	event(e: ThreadEvent): void;
	/** The connection to the backend came up or went down. `version` is whatever the backend calls its version. */
	connected(up: boolean, info?: { version?: string }): void;
	log(event: string, data?: Record<string, unknown>): void;
};

// ---- inspect -------------------------------------------------------------------------------------

export type PostOptions = {
	/** The decision-queue page's base URL, when the page answers right now. Absent: post a plain notice. */
	queueUrl?: string;
	/** The page's VIEW key (src/core/capability.ts, `secrets/view-key`), put in the script address the post carries. Never the page's own key: a post is copied into the thread. A view needs it with `queueUrl`; without it the post is a notice. */
	capability?: string;
};
export type PostResult = { ok: boolean; detail: string; where: "view" | "notice" };

// ---- the page's waiting cards --------------------------------------------------------------------

export type OptionalCapability =
	| "answer"
	| "listWaiting"
	| "setTitle"
	| "transcriptPath"
	| "inspect"
	| "send"
	| "stewardProbe"
	| "compact"
	| "snapshot"
	| "alertDesk"
	| "handoffInstruction"
	| "threadLinks";

/**
 * The Alert Desk's thread: a second wake receiver, with its own transport and its own busy gate. The core drains the alert inbox
 * (src/core/alert-desk.ts) into wakes for the `desk` receiver, and the one relay sends them here (a second receiver, through its one serial queue), so the desk holds and digests on its own
 * thread's state, never the Steward's.
 */
type AlertDeskLane = {
	/** How a wake reaches the desk thread. Its `ready()` is false until the operator has made the desk (no URL), and then nothing is drained. */
	wake: WakeTransport;
	/** Does the desk thread have a turn running or queued? Like `Adapter.isBusy`, for the desk's thread. */
	isBusy(): Gate;
};

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
	send?(
		threadId: string,
		text: string,
		seed: string,
		identity?: "steward" | "daemon" | "operator",
	): Promise<{ ok: boolean; detail: string }>;
	/** The Steward's size, stall and compaction state. */
	stewardProbe?(): StewardProbe;
	/**
	 * A fresh, whole read of every thread on this adapter's server, taken now over a connection of its own: never the watcher's
	 * cache. Rejects when the server cannot be reached. The held-ledger reconciler closes a hold on a thread only from this.
	 */
	snapshot?(): Promise<ThreadSnapshot>;
	/** How a compaction request reaches the Steward. Its `send` takes no message. */
	readonly compact?: WakeTransport;
	/** The Alert Desk thread: its wake transport and busy gate. */
	readonly alertDesk?: AlertDeskLane;
	/**
	 * How the Steward starts its own hand-off on this backend: one or two sentences the hand-off wake carries (T3: run the `/steward-handoff`
	 * command). When the Steward-health check says HAND OFF the daemon queues that wake itself. An adapter without this capability leaves
	 * the hand-off to the operator: the daemon asks them instead.
	 */
	handoffInstruction?(): string;
	/**
	 * Links to one of this server's threads (`ThreadLinks`), or `undefined` when `threadId` is not an id this backend issues: then
	 * nothing links to it, not even a prefix from the page's config. Synchronous and never slow: an adapter that must look something
	 * up first (T3 asks its server which environment it is) answers with what it knows now and looks it up in the background.
	 */
	threadLinks?(threadId: string): ThreadLinks | undefined;

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
	/**
	 * A private value, trimmed, or undefined when it is not there: a secret (`secrets/<name>`, mode 0600), or for a thread id name
	 * (`steward-thread`, `decisions-thread`, `desk-thread`) the matching `threads` key of config.json (src/core/layout.ts `readNamed`).
	 */
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
