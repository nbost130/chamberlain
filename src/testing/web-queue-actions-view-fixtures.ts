import { readFileSync } from "node:fs";

const SOURCE = readFileSync(new URL("../web/static/app.js", import.meta.url), "utf8");

/** Saturday 14 November 2026, 12:00 in whatever zone the test runs in. */
const NOW = new Date(2026, 10, 14, 12, 0, 0);

export const item = (id: string, over: Record<string, unknown> = {}) => ({
	id,
	kind: "product",
	title: `Title ${id}`,
	context: "ctx",
	options: [{ label: "A · One" }, { label: "B · Two" }],
	recommended: 0,
	status: "open",
	createdAt: "2026-11-14T08:00:00.000Z",
	thread: "Billing thread",
	server: "main",
	open: "/open/main/t1",
	batchable: true,
	...over,
});

export const snoozedItem = (id: string, until: Date, over: Record<string, unknown> = {}) =>
	item(id, { snooze: { until: until.toISOString(), at: NOW.toISOString(), active: true, returned: false }, ...over });

type Call = { path: string; body: any };

/** The page with a queue in it: its taps, typing and timers can be driven, and every request it makes is recorded. */
export async function page(
	queue: () => { items: unknown[]; snoozed?: unknown[]; cards?: unknown[] },
	o: {
		now?: Date;
		path?: string;
		reply?: (path: string, body: any) => { status?: number; json: unknown };
		confirm?: () => boolean;
	} = {},
) {
	const now = o.now ?? NOW;
	const listeners: Record<string, (ev: any) => unknown> = {};
	const app: any = {
		innerHTML: "",
		className: "",
		addEventListener: (t: string, f: (ev: any) => unknown) => {
			listeners[t] = f;
		},
	};
	const toast = { textContent: "", className: "", hidden: true };
	const custom = { value: "" };
	const note = { focused: false, focus() {} };
	note.focus = () => {
		note.focused = true;
	};
	const calls: Call[] = [];
	/** The addresses the page replaced its own with (a phone moves on to the next item this way). */
	const went: string[] = [];
	let reads = 0;
	const timers: { fn: () => unknown; ms: number }[] = [];
	const document = {
		getElementById: (id: string) =>
			id === "app" ? app : id === "toast" ? toast : id === "snooze-custom" ? custom : id === "note" ? note : null,
		addEventListener() {},
		querySelector: () => null,
		activeElement: null,
	};
	const fetch = async (path: string, init?: { body?: string }) => {
		if (!init?.body) {
			reads++;
			return { ok: true, status: 200, json: async () => ({ cards: [], rulings: [], ...queue() }) };
		}
		const body = JSON.parse(init.body);
		calls.push({ path, body });
		const r = o.reply?.(path, body) ?? { json: { ok: true, until: "2026-11-14T13:00:00.000Z" } };
		return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.json };
	};
	class FixedDate extends Date {
		constructor(...a: unknown[]) {
			super(...((a.length ? a : [now.getTime()]) as [number]));
		}
		static override now() {
			return now.getTime();
		}
	}
	const noop = () => {};
	new Function(
		"document",
		"window",
		"location",
		"history",
		"matchMedia",
		"fetch",
		"setTimeout",
		"clearTimeout",
		"setInterval",
		"confirm",
		"Date",
		SOURCE,
	)(
		document,
		{ addEventListener: noop },
		{ pathname: o.path ?? "/" },
		{ replaceState: (_s: unknown, _t: string, path: string) => went.push(path), pushState: noop },
		() => ({ matches: false }),
		fetch,
		(fn: () => unknown, ms: number) => timers.push({ fn, ms }),
		noop,
		() => 0,
		o.confirm ?? (() => true),
		FixedDate,
	);
	const settle = () => new Promise((r) => setTimeout(r, 15));
	await settle();
	/** A tap on an element that carries these data attributes (the page delegates every click from #app). */
	const tap = async (dataset: Record<string, string>) => {
		await listeners.click({ target: { closest: () => ({ dataset }) } });
		await settle();
	};
	const type = async (id: string, value: string) => {
		await listeners.input({ target: { id, value } });
	};
	return {
		app,
		toast,
		custom,
		note,
		calls,
		went,
		tap,
		type,
		settle,
		timers,
		reads: () => reads,
		html: () => app.innerHTML as string,
	};
}

export const BUTTONS = ["Open thread", "Snooze", "Direction", "Dismiss"];

/** The row of little buttons along the bottom of the item's detail: its text, in order. */
export const rowOf = (html: string) => {
	const row = html.match(/<div class="item-actions"[^>]*>(.*?)<\/div>/s)?.[1] ?? "";
	return [...row.matchAll(/<(?:a|button)[^>]*>([^<]*)<\/(?:a|button)>/g)].map((m) => m[1]);
};

export const at = (d: Date) => d.toISOString();
