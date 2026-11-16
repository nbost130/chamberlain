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

import {
	type Adapter,
	normalizeThread,
	type PostOptions,
	type PostResult,
	type ThreadEvent,
	type ThreadInput,
	type WatchSink,
} from "../core/adapter.ts";
import type { Inspector, StewardProbe, Transcript } from "../core/adapter-inspect.ts";
import type { AnswerOutcome, WaitingCard, WaitingRead } from "../core/adapter-waiting.ts";
import type { WakeTransport } from "../core/deliver.ts";
import type { Gate } from "../core/hold.ts";
import type { Question } from "../core/questions.ts";
import { ALL_CAPABILITIES, type FakeAdapter, type FakeOptions, type FakeThread } from "./fake-adapter-types.ts";

export type { FakeAdapter, FakeOptions };
export { ALL_CAPABILITIES };

export function createFakeAdapter(opts: FakeOptions = {}): FakeAdapter {
	const caps = new Set(opts.capabilities ?? ALL_CAPABILITIES);
	let sink: WatchSink | undefined;
	const early: ThreadEvent[] = [];
	let busy: Gate = "idle";
	let wakeReady = opts.wakeReady ?? true;
	let status = opts.wakeStatus ?? (() => 202);
	let deskBusy: Gate = "idle";
	let deskReady = true;
	const handles = {
		/** Every wake accepted, in order. */
		wakes: [] as { deliveryId: string; message: string }[],
		/** Every wake attempt, accepted or not. */
		attempts: 0,
		/** Every compaction request. */
		compactions: [] as string[],
		/** Every wake the Alert Desk's transport accepted, in order. */
		deskWakes: [] as { deliveryId: string; message: string }[],
		deskAttempts: 0,
		posted: [] as { item: Question; opts: PostOptions }[],
		titles: [] as string[],
		answers: [] as { card: WaitingCard; choice: number; sig: string }[],
		sends: [] as { threadId: string; text: string; seed: string; identity?: string }[],
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
		listed: new Map<string, ThreadInput>(),
		snapshotError: undefined as string | undefined,
		snapshotComplete: true,
	};

	const wake: WakeTransport = {
		ready: () => wakeReady,
		send: async (deliveryId, message) => {
			fake.attempts++;
			const s = status(deliveryId);
			if (s < 300) handles.wakes.push({ deliveryId, message });
			return { ok: s < 300, status: s };
		},
	};
	const inspect: Inspector = {
		lastMessage: async (id, runId) => {
			const th = fake.threads.get(id);
			if (runId && th?.runMessages?.[runId] !== undefined) return th.runMessages[runId]!;
			if (runId && th?.instruction?.items.length) {
				const last = [...th.instruction.items]
					.reverse()
					.find((i) => i.runId === runId && i.type === "assistant_message" && i.status === "completed");
				if (last) return String(last.text ?? "");
			}
			return th?.lastMessage ?? "";
		},
		lastAssistant: async (id) => fake.threads.get(id)?.lastAssistant,
		waiting: async (id): Promise<WaitingRead> => {
			const th = fake.threads.get(id);
			if (th?.waitingError) throw Error(th.waitingError);
			if (th?.waitingRead) return typeof th.waitingRead === "function" ? th.waitingRead() : th.waitingRead;
			if (!fake.connected) return { ok: false, reason: "fake is not connected" };
			return { ok: true, cards: th?.waiting ?? [], resolved: th?.resolved ?? [] };
		},
		runningSubagents: async (id) => fake.threads.get(id)?.subagents ?? 0,
		instruction: async (id, runId) => {
			const base = fake.threads.get(id)?.instruction ?? { items: [], state: "complete" as const, byMachine: false };
			if (!runId) return base;
			return {
				...base,
				items: base.items.filter((i) => i.runId === runId && i.type !== "run_interrupt_request"),
			};
		},
		runs: async (id) => fake.threads.get(id)?.runs ?? [],
		/** Prefers the live inspect overrides so tests that replace `runs` / `instruction` stay coherent. */
		handoffSnapshot: async (id) => {
			const runs = await inspect.runs!(id);
			const read = await inspect.instruction(id);
			return { runs, items: read.items };
		},
		failure: async (id) => fake.threads.get(id)?.failure,
		/** The failure's run, still failed with nothing going, unless the test says otherwise. */
		look: async (id) => {
			const th = fake.threads.get(id);
			return (
				th?.look ??
				(th?.failure
					? { latestRunId: th.failure.runId, latestStatus: "failed", active: false, waiting: false }
					: undefined)
			);
		},
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
				const done = () => {
					fake.connected = false;
					s.connected(false);
					resolve();
				};
				if (signal.aborted) done();
				else signal.addEventListener("abort", done, { once: true });
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
		...(caps.has("answer")
			? {
					answer: async (card: WaitingCard, choice: number, sig: string) => {
						handles.answers.push({ card, choice, sig });
						return fake.answerOutcome;
					},
				}
			: {}),
		...(caps.has("listWaiting")
			? {
					listWaiting: async () => {
						if (fake.listError) throw Error(fake.listError);
						return fake.cards;
					},
				}
			: {}),
		...(caps.has("setTitle")
			? {
					setTitle: async (title: string) => {
						handles.titles.push(title);
						return "set" as const;
					},
				}
			: {}),
		...(caps.has("transcriptPath") ? { transcriptPath: async () => fake.transcript } : {}),
		...(caps.has("inspect") ? { inspect } : {}),
		...(caps.has("send")
			? {
					send: async (threadId: string, text: string, seed: string, identity?: string) => {
						handles.sends.push({ threadId, text, seed, ...(identity ? { identity } : {}) });
						return { ok: true, detail: `sent to fake:${threadId}` };
					},
				}
			: {}),
		...(caps.has("stewardProbe") ? { stewardProbe: () => fake.probe } : {}),
		...(caps.has("snapshot")
			? {
					snapshot: async () => {
						if (fake.snapshotError) throw Error(fake.snapshotError);
						return {
							complete: fake.snapshotComplete,
							threads: [...fake.listed.values()].map((t) => {
								const n = normalizeThread(t);
								return {
									id: n.id,
									archived: n.archived,
									settled: n.settled,
									pendingRequestId: n.pendingRequestId,
									status: n.status,
								};
							}),
						};
					},
				}
			: {}),
		...(caps.has("alertDesk")
			? {
					alertDesk: {
						wake: {
							ready: () => deskReady,
							send: async (deliveryId: string, message: string) => {
								handles.deskAttempts++;
								handles.deskWakes.push({ deliveryId, message });
								return { ok: true, status: 202 };
							},
						},
						isBusy: () => deskBusy,
					},
				}
			: {}),
		...(caps.has("handoffInstruction") ? { handoffInstruction: () => "Run the hand-off now." } : {}),
		...(caps.has("threadLinks")
			? {
					threadLinks: (threadId: string) => ({
						ref: `fake-thread://${encodeURIComponent(threadId)}`,
						app: `fake-app://threads/${encodeURIComponent(threadId)}`,
					}),
				}
			: {}),
		...(caps.has("compact")
			? {
					compact: {
						ready: () => wakeReady,
						send: async (deliveryId: string) => {
							handles.compactions.push(deliveryId);
							return { ok: true, status: 202 };
						},
					} satisfies WakeTransport,
				}
			: {}),
	};
	Object.assign(adapter, optional);

	const fake: FakeAdapter = Object.assign(adapter, handles, {
		/** Reports a thread event as the backend would. Events emitted before `watch` starts are kept and delivered when it does. */
		emit(e: ThreadEvent) {
			fake.listed.set(e.thread.id, e.thread);
			if (sink) sink.event(e);
			else early.push(e);
		},
		unlist(id: string) {
			fake.listed.delete(id);
		},
		setConnected(up: boolean) {
			fake.connected = up;
			sink?.connected(up);
		},
		setBusy(g: Gate) {
			busy = g;
		},
		setDeskBusy(g: Gate) {
			deskBusy = g;
		},
		setDeskReady(ready: boolean) {
			deskReady = ready;
		},
		setWakeReady(ready: boolean) {
			wakeReady = ready;
		},
		setWakeStatus(f: (deliveryId: string) => number) {
			status = f;
		},
	});
	return fake;
}
