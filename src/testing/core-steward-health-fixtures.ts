import { readFileSync } from "node:fs";
import { createOutbox } from "../core/deliver.ts";
import { type Health, handoffDeliveryId, handoffWakeMessage, measure as measureWith } from "../core/steward-health.ts";
import { healthTicker } from "../core/steward-health-ticker.ts";
import type { memStore } from "./store.ts";

// The format signal reads a prompt hook that grades each reply; this is its pattern, as an operator would configure it.
const formatPattern = /FORMAT CONTRACT[^\n]*Last response (broke:|was clean)/;

// What an adapter tells the health check about its tools: here the fixtures' `t3_thread_read` and a `peek.ts` shell call.
const threadReadKey = (tool: string, input: Record<string, any>) => {
	if (tool.endsWith("t3_thread_read") && typeof input.threadId === "string")
		return `${input.environmentId ?? "local"}:${input.threadId}`;
	const m = tool === "Bash" ? String(input.command ?? "").match(/\bpeek\.ts\s+([\w-]+)\s+([\w:-]+)/) : null;
	return m ? `${m[1]}:${m[2]}` : undefined;
};

export const measure = (lines: Iterable<string>, session: string, now?: number) =>
	measureWith(lines, session, now, { formatPattern, threadReadKey });

// Synthetic ids, built at runtime: the Steward's native session must look like a UUID.
export const fakeId = (c: string) => [8, 4, 4, 4, 12].map((n) => c.repeat(n)).join("-");

export const session = fakeId("a");

export const fixture = readFileSync(new URL("../core/fixtures/steward-health.jsonl", import.meta.url), "utf8")
	.replaceAll("{{SESSION}}", session)
	.trim()
	.split("\n");

export const row = (x: object) => JSON.stringify(x);

export const assistant = (tokens: number, content: object[] = [], timestamp = "2026-11-10T13:03:00Z") =>
	row({ type: "assistant", timestamp, message: { usage: { input_tokens: tokens }, content } });

export const hook = (i: number, broken = true) =>
	row({
		type: "attachment",
		uuid: `new-${i}`,
		attachment: { type: "hook_additional_context", hookEvent: "UserPromptSubmit" },
		rendered: `FORMAT CONTRACT: Last response ${broken ? "broke: test" : "was clean"}`,
	});

export const degraded = (active: () => string, now: () => number) => () =>
	measure(
		[
			...fixture,
			row({ type: "system", subtype: "compact_boundary", timestamp: "new" }),
			hook(1),
			hook(2),
			hook(3),
			assistant(10_000),
		],
		active(),
		now(),
	);

export const INSTRUCTION = "Run the hand-off now.";

type MemStore = ReturnType<typeof memStore>;

/** A ticker the way the engine wires it for an adapter with `handoffInstruction`: the wake is an outbox row under the session's own id. */
export const handingOff = (store: MemStore, collect: () => Promise<Health>, now: () => number) => {
	const outbox = createOutbox({ store, log: () => {} });
	return healthTicker({
		store,
		collect,
		now,
		handoff: (h, s) => {
			outbox.deliver(handoffWakeMessage(h, INSTRUCTION), handoffDeliveryId(s), { kind: "handoff" });
		},
	});
};

export const queued = (store: MemStore) => store.wakes.rows().filter((r) => r.kind === "handoff");
