import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Bank, DEFAULT_BANK } from "../core/classifier/bank.ts";
import type { ClassifyThread } from "../core/classifier/classify.ts";
import { CLASSIFIER_DEFAULTS, type ClassifierConfig } from "../core/classifier/config.ts";
import type { Provider, ProviderResult } from "../core/classifier/providers.ts";
import type { SentState } from "../core/classifier/state.ts";
import type { Store } from "../core/store.ts";

export const NOW = Date.parse("2026-11-14T12:00:00Z");

export const IDS = DEFAULT_BANK.map((q) => q.id);

export const no = Object.fromEntries(IDS.map((id) => [id, 0.02]));

/** A canary that must never reach the database. */
export const CANARY = "CANARY-the-thread-text-7f3a";

export const thread = (id: string, over: Partial<ClassifyThread> = {}): ClassifyThread => ({
	server: "main",
	threadId: id,
	lastMessageHash: `h-${id}`,
	idleMinutes: 120,
	title: `Thread ${id} ${CANARY}`,
	lastMessage: `${CANARY} say go and I'll start it.`,
	previous: { from: "human", text: `${CANARY} what now?` },
	...over,
});

export const cfg = (over: Partial<ClassifierConfig> = {}): ClassifierConfig => ({
	...structuredClone(CLASSIFIER_DEFAULTS),
	provider: "jev",
	allowTextToLeaveMachine: true,
	...over,
});

/** A fake provider: answers per thread title, records each state it was sent, can be told to fail. */
export function fakeProvider(
	answer: (s: SentState) => Record<string, number> | Error = () => ({ ...no, asks_decision: 0.98 }),
	o: { name?: Provider["name"]; model?: string; costUsd?: number } = {},
) {
	const sent: SentState[] = [];
	const provider: Provider = {
		name: o.name ?? "jev",
		model: o.model ?? "jev-1.14.0",
		classify: async (state, _bank: Bank): Promise<ProviderResult> => {
			sent.push(state);
			const a = answer(state);
			if (a instanceof Error) throw a;
			return { answers: a, model: "jev-1.14.0", inputTokens: 1717, costUsd: o.costUsd ?? 0.000072, latencyMs: 104 };
		},
	};
	return { provider, sent };
}

export const deps = (store: Store, p: Provider, over: object = {}) => {
	const logs: { event: string; data?: Record<string, unknown> }[] = [];
	return {
		logs,
		d: {
			store,
			conf: mkdtempSync(join(tmpdir(), "conf-")),
			log: (event: string, data?: Record<string, unknown>) => logs.push({ event, ...(data ? { data } : {}) }),
			now: NOW,
			provider: () => p,
			...over,
		},
	};
};

export const key = (t: ClassifyThread) => `${t.server}:${t.threadId}:${t.lastMessageHash}`;
