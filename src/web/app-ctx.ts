/** What the page's handlers run on: its dependencies, the context made from them, and how an item or card is shown. */
import type { WaitingCard } from "../core/adapter.ts";
import type { Capability } from "../core/capability.ts";
import { batchable, type QuestionState, questionStates } from "../core/questions.ts";
import type { Clock } from "../core/rulings.ts";
import type { Store } from "../core/store.ts";
import { createItemActions } from "./queue-actions.ts";
import type { Linker } from "./thread-links.ts";
import type { SendToThread, Waiting } from "./waiting.ts";

export type AppDeps = {
	/** The database the queue, rulings, claims and wakes live in. */
	store: Store;
	/** The state directory: where the evidence files live (the Store holds the rows that point to them). */
	state: string;
	/** Sends a thread-routed answer straight to its thread (threadSender in ./waiting.ts). Without it, every answer goes to the Steward. */
	sendToThread?: SendToThread;
	log: (event: string, data?: Record<string, unknown>) => void;
	/** Host header values accepted, e.g. "<tailscale-ip>:3790". A request for any other host is refused (DNS rebinding). */
	hosts: string[];
	/**
	 * The capability token every request to the API, an item's evidence and the page itself must prove it holds (src/core/capability.ts). There is
	 * no way to leave it out: a page without one would answer anything that reaches its port.
	 */
	capability: Capability;
	/** Each card's thread link, and where `/open/<server>/<threadId>` sends a device (./thread-links.ts). Without it no card links to its thread. */
	links?: Linker;
	/** Cards waiting in other threads (src/web/waiting.ts). */
	mirror?: Pick<Waiting, "list" | "answer"> & Partial<Pick<Waiting, "unreachable" | "secretRequest">>;
	/** A directory holding index.html, app.css, app.js and inline.js; or `staticFiles`. */
	staticDir?: string;
	/** Each static file's path by the URL path it is served at (src/embedded.ts); wins over `staticDir`. */
	staticFiles?: Record<string, string>;
	testMode?: boolean;
	/** The clock the confirmation challenges and the rulings (what has expired) use. Default Date.now; tests move it. */
	now?: () => number;
};

/** What every part of one page shares: its deps, the one-change-at-a-time chain, the background tasks and the queue's reads. */
export type Ctx = {
	d: AppDeps;
	serial: <T>(fn: () => Promise<T> | T) => Promise<T>;
	track: (p: Promise<unknown>) => void;
	background: Set<Promise<unknown>>;
	/** The delivery IDs whose direct send is running now. */
	sending: Set<string>;
	state: () => ReturnType<typeof questionStates>;
	clock: Clock;
	/** Snooze, un-snooze, direction and dismiss (./queue-actions.ts). */
	items: ReturnType<typeof createItemActions>;
};

export function makeCtx(d: AppDeps): Ctx {
	// One change at a time: two answers to the same item must not both see it open.
	let chain: Promise<unknown> = Promise.resolve();
	const serial = <T>(fn: () => Promise<T> | T): Promise<T> => {
		const p = chain.then(fn, fn);
		chain = p.catch(() => undefined);
		return p;
	};
	const background = new Set<Promise<unknown>>();
	// A rejected background task is logged, never left unhandled: the next heartbeat retries it.
	const track = (p: Promise<unknown>) => {
		const q = p.catch((e) => d.log("background-error", { error: String(e).slice(0, 200) }));
		background.add(q);
		q.finally(() => background.delete(q));
	};
	const clock: Clock = () => d.now?.() ?? Date.now();
	return {
		d,
		serial,
		track,
		background,
		sending: new Set<string>(),
		// A snooze is read against the clock, so one whose time has passed is back on the active list.
		state: () => questionStates(d.store, clock()),
		clock,
		items: createItemActions({ store: d.store, clock, log: d.log, serial }),
	};
}

const linkOf = (d: AppDeps, server: string, threadId: string | undefined) => {
	if (!threadId || !d.links) return {};
	const link = d.links.link(server, threadId);
	const open = d.links.openPath(server, threadId);
	const app = d.links.appLink(server, threadId);
	return { ...(link ? { link } : {}), ...(open ? { open } : {}), ...(app ? { app } : {}) };
};
/**
 * A secret question's request in its thread, as the mirror's last reads show it (./waiting.ts `secretRequest`): `ended` once no secret
 * box waits there, so the card says the request expired instead of pointing at a box that is gone. Left out when the reads cannot tell.
 * The question stays open either way: the thread still needs the value, and only the thread can open a new box.
 */
const secretOf = (d: AppDeps, i: QuestionState) => {
	if (!i.secret || i.status !== "open") return {};
	const s = d.mirror?.secretRequest?.(i);
	return s ? { secretRequest: s } : {};
};
export const view = (d: AppDeps, i: QuestionState) => ({
	...i,
	...linkOf(d, i.server, i.threadId),
	...secretOf(d, i),
	batchable: batchable(i),
});
/** A card read from a thread keeps the link its adapter gave; the page adds the path that opens it from a frame, and the app link. */
export const cardView = (d: AppDeps, c: WaitingCard) => {
	const open = d.links?.openPath(c.server, c.threadId);
	const app = d.links?.appLink(c.server, c.threadId);
	return open || app ? { ...c, ...(open ? { open } : {}), ...(app ? { app } : {}) } : c;
};

// ---- a thread-routed answer's direct send -------------------------------------------------------------
