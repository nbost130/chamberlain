/** The fake adapter's types and its default capability list (see fake-adapter.ts). */
import type { Adapter, OptionalCapability, PostOptions, ThreadEvent, ThreadInput } from "../core/adapter/adapter.ts";
import type { LastAssistant, RunFailure, RunLook, StewardProbe, Transcript } from "../core/adapter/adapter-inspect.ts";
import type { AnswerOutcome, WaitingCard, WaitingItem, WaitingRead } from "../core/adapter/adapter-waiting.ts";
import type { Gate } from "../core/decide/hold.ts";
import type { Question } from "../core/items/questions.ts";
import type { InstructionRead } from "../core/ops/history.ts";

export const ALL_CAPABILITIES: readonly OptionalCapability[] = [
	"answer",
	"listWaiting",
	"setTitle",
	"transcriptPath",
	"inspect",
	"send",
	"stewardProbe",
	"compact",
	"snapshot",
	"alertDesk",
	"handoffInstruction",
	"threadLinks",
];

/**
 * What `inspect` reports for one thread; anything unset reads as empty. `waiting` is the cards seen waiting and `resolved` the
 * request IDs seen in a terminal status,
 * unless `waitingRead` replaces the whole result (an `ok: false`, or a shape that breaks the contract) or
 * `waitingError` makes the read throw. Otherwise, while the fake is not connected, every waiting read is `ok: false`, as the
 * contract says. `waitingRead` is returned whatever the connection, so a test can prove the core does not believe it.
 */
export type FakeThread = {
	lastMessage?: string;
	/** Per-run finals when a handoff wake must not pick a later run's text (issue #74). */
	runMessages?: Record<string, string>;
	/** What `lastAssistant` reports (id, text, ISO time). Unset: the thread has no finished assistant message. */
	lastAssistant?: LastAssistant;
	waiting?: WaitingItem[] /** Request IDs the backend shows in a terminal status: the only thing that closes a card hold. */;
	resolved?: string[];
	waitingRead?: WaitingRead | (() => WaitingRead);
	waitingError?: string;
	subagents?: number;
	instruction?: InstructionRead;
	/** Runs for the handoff gate (completed-only, human-successor suppress). */
	runs?: { id?: string; ordinal?: number; status?: string }[];
	failure?: RunFailure;
	look?: RunLook;
	/** When the principal last wrote in the thread, in epoch ms: what `principalLastWrite` reports if it is not before the window asked for. `"error"` makes the read throw, `"hang"` never answers. Unset: they never did. */
	principalAt?: number | "error" | "hang";
};

export type FakeOptions = {
	id?: string;
	/** The optional capabilities to declare and implement. Default: all. */
	capabilities?: readonly OptionalCapability[];
	/** Does the wake transport have somewhere to send? Default true. */
	wakeReady?: boolean;
	/** The status the wake transport answers with. Default 202. */
	wakeStatus?: (deliveryId: string) => number;
};

/** The adapter, plus the handles a test drives it and reads it with. Scalar handles are read live, so assigning them takes effect. */
export type FakeAdapter = Adapter & {
	wakes: { deliveryId: string; message: string }[];
	attempts: number;
	compactions: string[];
	deskWakes: { deliveryId: string; message: string }[];
	deskAttempts: number;
	posted: { item: Question; opts: PostOptions }[];
	titles: string[];
	answers: { card: WaitingCard; choice: number; sig: string }[];
	sends: { threadId: string; text: string; seed: string; identity?: string }[];
	cards: WaitingCard[];
	listError: string | undefined;
	answerOutcome: AnswerOutcome;
	threads: Map<string, FakeThread>;
	probe: StewardProbe;
	transcript: Transcript;
	connected: boolean;
	/** Every thread the fake backend lists, as `snapshot` reports it: filled by `emit`, and by `unlist` removed. */
	listed: Map<string, ThreadInput>;
	/** Set to make `snapshot` reject, as an unreachable server does. */
	snapshotError: string | undefined;
	/** False makes `snapshot` say it may be partial. */
	snapshotComplete: boolean;
	emit(e: ThreadEvent): void;
	unlist(id: string): void;
	/** The watcher's connection drops (false) or comes back (true), as a real server's socket does; `watch` keeps running. */
	setConnected(up: boolean): void;
	setBusy(g: Gate): void;
	setDeskBusy(g: Gate): void;
	setDeskReady(ready: boolean): void;
	setWakeReady(ready: boolean): void;
	/** The webhook's answer to each wake, given its delivery id. */
	setWakeStatus(f: (deliveryId: string) => number): void;
};
