import { afterEach } from "bun:test";
import type { WaitingCard } from "../core/adapter/adapter-waiting.ts";
import { createWaiting, type ServerAdapter } from "../web/waiting.ts";
import type { FakeAdapter } from "./fake-adapter.ts";
import { memStore } from "./store.ts";

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useWebWaitingFixtures() {
	const card = (over: Partial<WaitingCard> = {}): WaitingCard => ({
		id: "C-aaaaaaaaaaaa",
		type: "question",
		server: "ws",
		threadId: "t1",
		threadTitle: "Thread one",
		requestId: "r1",
		question: "Merge now?",
		options: [{ label: "Yes" }, { label: "No" }],
		answerable: true,
		sig: "sig-1",
		...over,
	});

	const logs: { event: string; [k: string]: unknown }[] = [];

	const pair = (fake: FakeAdapter, name = "ws"): ServerAdapter => ({
		server: { name, adapter: "fake" },
		adapter: fake,
	});

	const mirror = (
		pairs: ServerAdapter[],
		extra: { links?: Record<string, string>; timeoutMs?: number; now?: () => number } = {},
	) =>
		createWaiting({
			store: memStore(),
			servers: () => pairs,
			skipThreads: () => ["skipped"],
			log: (event, data) => logs.push({ event, ...data }),
			...extra,
		});

	afterEach(() => {
		logs.length = 0;
	});

	return { card, logs, pair, mirror };
}
