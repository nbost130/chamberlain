import type { Rpc } from "../adapters/t3/rpc.ts";
import { T3Link } from "../adapters/t3/watch.ts";
import type { AdapterEnv } from "../core/adapter/adapter.ts";
import type { WaitingItem } from "../core/adapter/adapter-waiting.ts";
import type { CardThreadRead } from "../core/items/card-reconcile.ts";

export const approval = { type: "approval_request", status: "waiting", requestId: "a1", label: "deploy" };

export const link = (request: (tag: string, payload: unknown) => Promise<unknown>) => {
	const l = new T3Link({} as AdapterEnv, {
		name: "main",
		adapter: "t3",
		origin: "http://127.0.0.1:1",
		tokenFile: "read-token",
	});
	l.rpc = { request } as unknown as Rpc;
	return l;
};

/** What the engine does with an adapter read: an `ok: true` listing becomes the request IDs waiting; anything else stays as it is. */
export const asCardRead = async (l: T3Link, threadId: string): Promise<CardThreadRead> => {
	const r = await l.inspector.waiting(threadId);
	return r.ok
		? { ok: true, waiting: new Set(r.cards.map((c) => c.requestId)), resolved: new Set(r.resolved ?? []) }
		: r;
};

export const card: WaitingItem = { type: "approval_request", requestId: "a1", label: "deploy", questions: [] };
