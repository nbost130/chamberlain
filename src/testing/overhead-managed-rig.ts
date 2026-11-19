/** A rig for the managed overhead ratio's tests: threads Chamberlain supervised (fire events and wake members), and a fake LifeOS that knows which sessions ran for which thread. */
import { collect } from "../core/overhead/collect.ts";
import type { OverheadConfig } from "../core/overhead/config.ts";
import type { OwnThreads } from "../core/overhead/managed.ts";
import { HOUR, MODEL, NOW, wake } from "./overhead-fixtures.ts";
import { memStore } from "./store.ts";

export type Store = ReturnType<typeof memStore>;
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

/** A store with $90 of Steward spend in the window, as the cost tests use. */
export function managedStore(): Store {
	const s = memStore();
	s.usage.upsert(Array.from({ length: 10 }, (_, i) => wake({ hoursAgo: 1 + i, usd: 9, tools: 1 })));
	return s;
}

/** The watcher fired a wake for this thread, on this server, `hoursAgo` hours ago. */
export const fire = (s: Store, id: string, server: string, o: { hoursAgo?: number; kind?: string } = {}) =>
	s.events.append({ t: iso(o.hoursAgo ?? 2), event: "fire", server, kind: o.kind ?? "turn_ended", threadId: id });

/** A wake or report naming the thread was queued for the Steward `hoursAgo` hours ago. */
export const member = (s: Store, id: string, hoursAgo = 3, kind = "note") =>
	s.wakes.hold({
		deliveryId: `${kind}:${id}:${hoursAgo}`,
		message: "m",
		queuedAt: NOW - hoursAgo * HOUR,
		kind,
		thread: id,
	});

/** thread id -> its sessions: the host they ran on and what they spent in the window, in micro-dollars. A thread not listed has no session row. */
export type Sessions = Record<string, { host: string; micros: number }>;

const FLEET = "k,name,micros\nfleet,h1,200000000\nfleet,h2,100000000";

/** A LifeOS that answers the fleet query with a fixed fleet, and the managed query from `sessions` for the ids in its IN list. */
export function lifeos(sessions: Sessions, calls: string[] = []) {
	return async (_command: string, args: string[]): Promise<string> => {
		const sql = args[2] ?? "";
		calls.push(sql);
		if (!sql.includes("'mthread'")) return FLEET;
		const rows = Object.entries(sessions)
			.filter(([id]) => sql.includes(`'${id}'`))
			.map(([id, v]) => `mthread,${v.host} ${id},${v.micros}`);
		return ["k,name,micros", ...rows].join("\n");
	};
}

/** `own` names the threads Chamberlain runs itself: `pinned`, the ledger's `butlers`, and its `investigators`. */
export const managedReport = (
	s: Store,
	cfg: OverheadConfig,
	query: ReturnType<typeof lifeos>,
	own: Partial<OwnThreads> = {},
) =>
	collect({
		store: s,
		cfg,
		model: MODEL,
		own,
		gh: async () => ({ total: 0, incomplete: false, items: [] }),
		query,
		now: NOW,
	});
