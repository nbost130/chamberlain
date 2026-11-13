/**
 * An in-memory adapter: a second implementation of the contract in src/core/adapter.ts, driven by the test. Core and
 * daemon-level tests run against it, which is what proves the core does not depend on any backend. It is also the
 * smallest worked example of an adapter (docs/ADAPTERS.md).
 *
 *   const fake = createFakeAdapter();
 *   fake.emit({ kind: "needs_input", thread: { id: "t1", title: "Build", status: "waiting", pendingRequestId: "r1" } });
 *   fake.setBusy("busy");
 *   fake.wakes;           // every wake the engine delivered, as { deliveryId, message }
 *
 * `capabilities` chooses which optional capabilities it declares (default: all of them). A capability it does not
 * declare has no method at all, so the core's degraded paths run exactly as they would for a thin real backend.
 */
import type { Adapter, AnswerOutcome, Inspector, OptionalCapability, PostOptions, PostResult, StewardProbe, ThreadEvent, Transcript, WaitingCard, WaitingItem, WatchSink } from "../core/adapter.ts";
import type { WakeTransport } from "../core/deliver.ts";
import type { Gate } from "../core/hold.ts";
import type { InstructionRead } from "../core/history.ts";
import type { Question } from "../core/questions.ts";

export const ALL_CAPABILITIES: readonly OptionalCapability[] = ["answer", "listWaiting", "setTitle", "transcriptPath", "inspect", "send", "stewardProbe", "compact"];

/** What `inspect` reports for one thread; anything unset reads as empty. */
export type FakeThread = { lastMessage?: string; waiting?: WaitingItem[]; subagents?: number; instruction?: InstructionRead };

export type FakeOptions = {
	id?: string;
	/** The optional capabilities to declare and implement. Default: all. */
	capabilities?: readonly OptionalCapability[];
	/** Does the wake transport have somewhere to send? Default true. */
	wakeReady?: boolean;
	/** The status the wake transport answers with. Default 202. */
	wakeStatus?: () => number;
};

/** The adapter, plus the handles a test drives it and reads it with. Scalar handles are read live, so assigning them takes effect. */
export type FakeAdapter = Adapter & {
	wakes: { deliveryId: string; message: string }[];
	attempts: number;
	compactions: string[];
	posted: { item: Question; opts: PostOptions }[];
	titles: string[];
	answers: { card: WaitingCard; choice: number; sig: string }[];
	sends: { threadId: string; text: string; seed: string }[];
	cards: WaitingCard[];
	listError: string | undefined;
	answerOutcome: AnswerOutcome;
	threads: Map<string, FakeThread>;
	probe: StewardProbe;
	transcript: Transcript;
	connected: boolean;
	emit(e: ThreadEvent): void;
	setBusy(g: Gate): void;
	setWakeReady(ready: boolean): void;
	setWakeStatus(f: () => number): void;
};

export function createFakeAdapter(opts: FakeOptions = {}): FakeAdapter {
	const caps = new Set(opts.capabilities ?? ALL_CAPABILITIES);
	let sink: WatchSink | undefined;
	const early: ThreadEvent[] = [];
	let busy: Gate = "idle";
	let wakeReady = opts.wakeReady ?? true;
	let status = opts.wakeStatus ?? (() => 202);
	const handles = {
		/** Every wake accepted, in order. */
		wakes: [] as { deliveryId: string; message: string }[],
		/** Every wake attempt, accepted or not. */
		attempts: 0,
		/** Every compaction request. */
		compactions: [] as string[],
		posted: [] as { item: Question; opts: PostOptions }[],
		titles: [] as string[],
		answers: [] as { card: WaitingCard; choice: number; sig: string }[],
		sends: [] as { threadId: string; text: string; seed: string }[],
		/** The cards `listWaiting` returns. */
		cards: [] as WaitingCard[],
		/** Set to make `listWaiting` throw, as an unreachable server does. */
		listError: undefined as string | undefined,
		/** What `answer` returns. */
		answerOutcome: { ok: true, choice: "answered" } as AnswerOutcome,
		threads: new Map<string, FakeThread>(),
		probe: { readable: true } as StewardProbe,
		transcript: { path: "/nonexistent/transcript.jsonl", session: "session-1", thread: "steward-1" } as Transcript,
		connected: false,
	};

	const wake: WakeTransport = {
		ready: () => wakeReady,
		send: async (deliveryId, message) => {
			fake.attempts++;
			const s = status();
			if (s < 300) handles.wakes.push({ deliveryId, message });
			return { ok: s < 300, status: s };
		},
	};
	const inspect: Inspector = {
		lastMessage: async (id) => fake.threads.get(id)?.lastMessage ?? "",
		waiting: async (id) => fake.threads.get(id)?.waiting ?? [],
		runningSubagents: async (id) => fake.threads.get(id)?.subagents ?? 0,
		instruction: async (id) => fake.threads.get(id)?.instruction ?? { items: [], state: "complete", byMachine: false },
	};

	const adapter: Adapter = {
		id: opts.id ?? "fake",
		capabilities: [...caps],
		watch: (s, signal) => {
			sink = s;
			fake.connected = true;
			s.connected(true, { version: "fake-1" });
			for (const e of early.splice(0)) s.event(e);
			return new Promise<void>((resolve) => {
				const done = () => { fake.connected = false; s.connected(false); resolve(); };
				if (signal.aborted) done(); else signal.addEventListener("abort", done, { once: true });
			});
		},
		wake,
		isBusy: () => busy,
		post: async (item, o): Promise<PostResult> => {
			handles.posted.push({ item, opts: o });
			return { ok: true, detail: "posted in memory", where: o.queueUrl ? "view" : "notice" };
		},
		serverLine: () => "server: fake (this server)",
	};
	// Optional capabilities exist only when declared: the core must see exactly what a thin backend offers.
	const optional: Partial<Adapter> = {
		...(caps.has("answer") ? { answer: async (card: WaitingCard, choice: number, sig: string) => { handles.answers.push({ card, choice, sig }); return fake.answerOutcome; } } : {}),
		...(caps.has("listWaiting") ? { listWaiting: async () => { if (fake.listError) throw Error(fake.listError); return fake.cards; } } : {}),
		...(caps.has("setTitle") ? { setTitle: async (title: string) => { handles.titles.push(title); return "set" as const; } } : {}),
		...(caps.has("transcriptPath") ? { transcriptPath: async () => fake.transcript } : {}),
		...(caps.has("inspect") ? { inspect } : {}),
		...(caps.has("send") ? { send: async (threadId: string, text: string, seed: string) => { handles.sends.push({ threadId, text, seed }); return { ok: true, detail: `sent to fake:${threadId}` }; } } : {}),
		...(caps.has("stewardProbe") ? { stewardProbe: () => fake.probe } : {}),
		...(caps.has("compact") ? { compact: { ready: () => wakeReady, send: async (deliveryId: string) => { handles.compactions.push(deliveryId); return { ok: true, status: 202 }; } } satisfies WakeTransport } : {}),
	};
	Object.assign(adapter, optional);

	const fake: FakeAdapter = Object.assign(adapter, handles, {
		/** Reports a thread event as the backend would. Events emitted before `watch` starts are kept and delivered when it does. */
		emit(e: ThreadEvent) { if (sink) sink.event(e); else early.push(e); },
		setBusy(g: Gate) { busy = g; },
		setWakeReady(ready: boolean) { wakeReady = ready; },
		setWakeStatus(f: () => number) { status = f; },
	});
	return fake;
}
