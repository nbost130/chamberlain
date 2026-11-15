import { normalizeThread, type ThreadInput } from "../core/adapter.ts";
import type { LastAssistant } from "../core/adapter-inspect.ts";
import { IDLE_PARENTS_DEFAULTS } from "../core/idle-parents.ts";
import { type IdleSelection, type IdleThread, type IdleThreadSource, messageHash } from "../core/idle-select.ts";

const MIN = 60_000;

export const NOW = Date.parse("2026-11-14T12:00:00Z");

export const thread = (over: Partial<ThreadInput> = {}) =>
	normalizeThread({ id: "t", title: "T", status: "idle", ...over });

export const last = (id: string, minutesIdle: number, text = "All done."): LastAssistant => ({
	id,
	text,
	at: new Date(NOW - minutesIdle * MIN).toISOString(),
});

/** A source of threads: each entry is a thread and its last message; `bad` threads throw when read. */
export function source(
	entries: { th: ThreadInput; last?: LastAssistant; bad?: boolean }[],
	o: {
		server?: string;
		connected?: boolean;
		children?: Record<string, number>;
		subagents?: Record<string, number | Error>;
		noRead?: boolean;
	} = {},
): IdleThreadSource & { failures: string[] } {
	const failures: string[] = [];
	const byId = new Map(entries.map((e) => [e.th.id, e]));
	return {
		server: o.server ?? "main",
		connected: o.connected ?? true,
		threads: entries.map((e) => normalizeThread(e.th)),
		liveChildren: (id) => o.children?.[id] ?? 0,
		...(o.noRead
			? {}
			: {
					lastAssistant: async (id: string) => {
						const e = byId.get(id)!;
						if (e.bad) throw Error("projection failed");
						return e.last;
					},
				}),
		...(o.subagents
			? {
					runningSubagents: async (id: string) => {
						const n = o.subagents![id] ?? 0;
						if (n instanceof Error) throw n;
						return n;
					},
				}
			: {}),
		readFailed: (id) => failures.push(id),
		failures,
	};
}

export const idle = (id: string, minutesIdle: number, text = "All done.", over: Partial<ThreadInput> = {}) => ({
	th: { id, title: `Thread ${id}`, status: "idle", ...over },
	last: last(`m-${id}`, minutesIdle, text),
});

export const rec = (id: string, minutesIdle: number, text = "All done.", server = "main"): IdleThread => {
	const l = last(`m-${id}`, minutesIdle, text);
	const looksLikeAsk = /go|\?|holding until|waiting (?:on|for)|adapt once|no reply needed while/i.test(text);
	return {
		server,
		threadId: id,
		title: `Thread ${id}`,
		idleMinutes: minutesIdle,
		lastMessage: text,
		lastMessageHash: messageHash(l),
		looksLikeAsk,
		previous: { from: "none", text: "" },
	};
};

export const sel = (threads: IdleThread[], unreadable: IdleSelection["unreadable"] = []): IdleSelection => ({
	threads,
	unreadable,
});

export const CFG = IDLE_PARENTS_DEFAULTS;
