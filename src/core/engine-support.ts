/** What the engine's watchers and core share: the servers and timings it is given, and the pure text a wake is made of. */
import type { Adapter, PostResult, ThreadState } from "./adapter.ts";
import { has } from "./adapter-conformance.ts";
import type { WaitingItem } from "./adapter-waiting.ts";
import type { ClassifyDeps } from "./classifier/classify.ts";
import { PrincipalPoss, principal, selfCommand } from "./config.ts";
import type { Candidate } from "./decide.ts";
import type { InstructionRead } from "./history.ts";
import type { GhRead } from "./hold-lookup.ts";
import type { Judge } from "./judge.ts";
import { setting } from "./layout.ts";
import type { Log } from "./log.ts";
import { threadHappened } from "./messages.ts";
import type { Question } from "./questions.ts";
import type { RecoverTiming } from "./recover-classify.ts";
import type { RelayDeps } from "./relay-ctx.ts";
import type { ServerEntry } from "./servers.ts";
import type { RelayLock } from "./singleton.ts";
import type { Store } from "./store.ts";

/** The key in the database's state table where recovery keeps what it must remember across a restart. */
export const RECOVER_KEY = "recover";

/** One configured server and the adapter that serves it. */
type EngineServer = { server: ServerEntry; adapter: Adapter };

export type EngineTiming = {
	/** A thread event settles this long before the engine looks at it again (a state change often comes in bursts). */
	debounceMs: number;
	/** The projection can lag the status by a moment: wait this long before calling a wait empty. */
	lagMs: number;
	/** How long a finished turn must stay quiet before it is reported (a PR update often follows). */
	quietMs: number;
	/** The heartbeat: the once-a-minute housekeeping. */
	tickMs: number;
	/** How long a card hold may go with no evidence (not seen waiting, not seen resolved) before the engine raises an alarm. */
	cardUnverifiedAlarmMs: number;
};
/**
 * The timings in force: `reportQuietMs` and `cardUnverifiedAlarmMs` from the environment or config.json (src/core/layout.ts), else the defaults.
 * CHAMBERLAIN_TICK_MS is a test knob and stays environment-only.
 */
export const defaultTiming = (): EngineTiming => ({
	debounceMs: 2500,
	lagMs: 3000,
	quietMs: setting("reportQuietMs") ?? 180_000,
	tickMs: Number(process.env.CHAMBERLAIN_TICK_MS ?? 60_000),
	cardUnverifiedAlarmMs: setting("cardUnverifiedAlarmMs") ?? 24 * 3_600_000,
});

export type EngineDeps = {
	conf: string;
	/** The held one-relay lock (`holdRelayLock`): the engine builds the relay, which cannot exist without it (relay.ts). */
	lock: RelayLock;
	/** The database every piece of state lives in (src/core/store.ts). */
	store: Store;
	/** Every server to watch. The Steward's own is the one with no environmentId (homeServer in servers.ts). */
	servers: EngineServer[];
	/** Watch and log, and post nothing. */
	dry?: boolean;
	/** Thread ids never to wake about. */
	exclude?: Iterable<string>;
	/** Where events go. Default: the database's event log. */
	log?: Log;
	timing?: Partial<EngineTiming>;
	/** Extra relay options (tests: the pause between attempts, the attempts, the hold ceiling, a clock). */
	relay?: Partial<Pick<RelayDeps, "retryAfterMs" | "maxAttempts" | "staleAfterMs" | "now" | "ceilingMs">>;
	/** Runs `ask.ts` for the Steward-health hand-off question, asked only when the adapter cannot start the hand-off itself (no `handoffInstruction`). Undefined: that question is not asked. */
	ask?: (raw: object) => Promise<void>;
	/** Shows a question where the operator reads, for a snoozed urgent one that returned. Default: the adapter's one-line notice; the daemon passes the pinned view (ask.ts `postQuestion`). */
	post?: (item: Question, adapter: Adapter) => Promise<PostResult>;
	/** The Steward's compaction size, in tokens. */
	compactAt?: number;
	/** Where the full-sweep prompt template lives when the config directory has no sweep-prompt.md. */
	sweepPromptFile?: string;
	/** Run the routine sweep and the Steward-health check. Off for a bare watcher. */
	housekeeping?: boolean;
	/** Stalled-thread recovery (src/core/recover.ts). OFF unless asked: `true` turns it on for an adapter that can read a failure, look at a thread and send; an object turns it on and overrides its timing (tests). The production launcher turns it on with CHAMBERLAIN_RECOVER=1. */
	recover?: boolean | Partial<RecoverTiming>;
	/** The Steward's token usage per wake (src/core/steward-tokens.ts). OFF unless asked (`stewardTokens`): when on, the daemon re-reads the Steward's transcript hourly and upserts its per-wake rows. */
	stewardTokens?: boolean;
	/** Runs the operator's alert command for an alarm. Default: executes it. A test passes `noAlert` (the `noAlert` helper in the testing directory) so it never reaches a real one. */
	alert?: (cmd: string, args: string[], env: NodeJS.ProcessEnv) => void;
	/** The one judge (src/core/judge.ts). Default: judge.json in the config directory. */
	judge?: Judge;
	/** The idle-thread classifier's provider (src/core/classifier/). Default: the one `sweep.idleParents.classifier` names. Tests pass a fake. */
	classifierProvider?: ClassifyDeps["provider"];
	/** Reads GitHub for the held-ledger reconciler (src/core/gh.ts). Undefined: holds that name a PR, issue or branch are not checked. */
	gh?: GhRead;
};

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
/** Pure: a word quoted for a POSIX shell, so a command printed in an alarm can be pasted as it is. */
const shellWord = (s: string) => (/^[A-Za-z0-9_.:@%+=,/-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
/** What an adapter without a history reports for every thread: nothing says who instructed it. */
export const NO_HISTORY: InstructionRead = { items: [], state: "complete", byMachine: false };
export const TOKEN_ALARM_WINDOW_MS = 6 * 3600_000;

/** One fire being decided: the candidate, the thread as it stands now, the draft of the wake and the keys the fire has staged. */
export type Fire = { c: Candidate; live: ThreadState; draft: Draft; mine: string[] };

/** What a wake's text is built from while a fire decides whether there is a wake at all. */
export type Draft = {
	excerpt: string;
	stalled: boolean;
	reported: boolean;
	idleLine: string;
	waitNote: string;
	question: string;
	failedWhat: string;
};

/** The note a wake carries about what a settled turn still has open: an older card, background tasks still running. */
export function settledNote(settled: { running: number; oldCard: boolean }): string {
	let note = "";
	if (settled.oldCard) note = "It also has an older open question card, which already had its own wake.";
	if (settled.running)
		note = [
			note,
			`It still has ${settled.running} background task${settled.running === 1 ? "" : "s"} running after a long wait.`,
		]
			.filter(Boolean)
			.join(" ");
	return note;
}

/** What the wake says happened, by the kind of fire. */
export function wakeWhat(kind: Candidate["kind"], draft: Draft): string {
	const what: Record<Candidate["kind"], string> = {
		needs_input: threadHappened.needsInput,
		failed: draft.failedWhat,
		turn_ended: draft.stalled
			? threadHappened.stalled
			: draft.idleLine
				? threadHappened.idle(draft.idleLine)
				: draft.reported
					? threadHappened.finished
					: threadHappened.handedBack,
	};
	return what[kind];
}

/** What the wake says is being waited on, from the request cards that are new. */
export function waitNoteFor(fresh: WaitingItem[], adapter: Adapter): string {
	const kinds = new Set(fresh.map((i) => i.type));
	let note = "";
	if (kinds.has("secret_request"))
		note = `WAITING ON: a SECRET request. Never answer it and never supply a value; it is ${PrincipalPoss()} alone.`;
	else if (kinds.has("approval_request"))
		note = `WAITING ON: a command or permission APPROVAL. ${adapter.approvalHint ? `${adapter.approvalHint} ` : ""}Read the command and tell ${principal()}.`;
	else if (kinds.size) note = "WAITING ON: a question with options.";
	const first = fresh[0];
	if (first?.label) note += ` (${clip(first.label, 100)})`;
	return note;
}

export const defaultServerLine = (srv: ServerEntry) =>
	srv.environmentId
		? `server: ${srv.name} (linked: environmentId ${srv.environmentId})`
		: `server: ${srv.name} (this server)`;

/** The desk lane of an adapter that has one: a second receiver of the one relay. */
export const deskLaneOf = (adapter: Adapter) => (has(adapter, "alertDesk") ? adapter.alertDesk : undefined);

/** The adapter that serves a server. */
export function adapterOf(servers: EngineServer[], server: ServerEntry): Adapter {
	const entry = servers.find((x) => x.server === server);
	if (!entry) throw Error(`the home server ${server.name} is not among the servers the engine was given`);
	return entry.adapter;
}

/** The command that closes a card hold by hand, as an alarm prints it. */
export const closeCardCommand = (server: string, requestId: string) =>
	`${selfCommand("afk")} close-card ${shellWord(server)} ${shellWord(requestId)} "<how it closed>"`;
