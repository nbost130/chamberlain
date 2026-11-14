import { readFileSync } from "node:fs";

export async function detail(context: string, over: Record<string, unknown> = {}): Promise<string> {
	const app: any = { innerHTML: "", className: "", addEventListener() {} };
	const document = {
		getElementById: (id: string) => (id === "app" ? app : { textContent: "", className: "", hidden: false }),
		addEventListener() {},
		querySelector: () => null,
		activeElement: null,
	};
	const it = {
		id: "Q-ctx1",
		kind: "product",
		title: "T",
		context,
		options: [{ label: "A" }, { label: "B" }],
		recommended: 0,
		status: "open",
		createdAt: new Date().toISOString(),
		thread: "t",
		server: "s",
		batchable: true,
		...over,
	};
	const fetch = async () => ({ ok: true, status: 200, json: async () => ({ items: [it], rulings: [] }) });
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
		readFileSync(new URL("../web/static/app.js", import.meta.url), "utf8"),
	)(
		document,
		{ addEventListener: noop },
		{ pathname: "/item/Q-ctx1" },
		{},
		() => ({ matches: false }),
		fetch,
		() => 0,
		noop,
		() => 0,
	);
	await new Promise((r) => setTimeout(r, 10));
	return app.innerHTML;
}

// ---- the full page asks the server for the approval's confirmation, and presents it ----

/** The page with a card in the queue: its clicks and changes can be fired, and every request it makes is recorded. */
export async function cardPage(
	cards: unknown[],
	reply: (path: string, body: any) => { status?: number; json: unknown },
) {
	const listeners: Record<string, (ev: any) => void> = {};
	const app: any = {
		innerHTML: "",
		className: "",
		addEventListener: (t: string, f: (ev: any) => void) => {
			listeners[t] = f;
		},
	};
	const calls: { path: string; body: any }[] = [];
	const document = {
		getElementById: (id: string) => (id === "app" ? app : { textContent: "", className: "", hidden: false }),
		addEventListener() {},
		querySelector: () => null,
		activeElement: null,
	};
	const fetch = async (path: string, init?: { body?: string }) => {
		if (!init?.body) return { ok: true, status: 200, json: async () => ({ items: [], cards, rulings: [] }) };
		const body = JSON.parse(init.body);
		calls.push({ path, body });
		const r = reply(path, body);
		return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: async () => r.json };
	};
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
		readFileSync(new URL("../web/static/app.js", import.meta.url), "utf8"),
	)(
		document,
		{ addEventListener: noop },
		{ pathname: "/" },
		{},
		() => ({ matches: false }),
		fetch,
		() => 0,
		noop,
		() => 0,
	);
	await new Promise((r) => setTimeout(r, 10));
	const click = async (act: string, cid: string) => {
		listeners.click({ target: { closest: () => ({ dataset: { cact: act, cid } }) } });
		await new Promise((r) => setTimeout(r, 10));
	};
	const pick = async (cid: string, value: number) => {
		listeners.change({ target: { dataset: { cid }, name: `copt-${cid}`, value: String(value) } });
		await new Promise((r) => setTimeout(r, 5));
	};
	return { app, calls, click, pick };
}

export const approval = {
	id: "C-0123456789ab",
	type: "approval",
	server: "main",
	threadId: "t",
	threadTitle: "Build",
	requestId: "r",
	header: "Approval",
	question: "Run this?",
	command: "rm -rf build",
	options: [{ label: "Approve once" }, { label: "Decline" }],
	recommended: 0,
	answerable: true,
	sig: "sig-1",
};

export async function list(items: Record<string, unknown>[]): Promise<string> {
	const app: any = { innerHTML: "", className: "", addEventListener() {} };
	const document = {
		getElementById: (id: string) => (id === "app" ? app : { textContent: "", className: "", hidden: false }),
		addEventListener() {},
		querySelector: () => null,
		activeElement: null,
	};
	const base = {
		options: [{ label: "A" }, { label: "B" }],
		recommended: 0,
		status: "open",
		context: "",
		thread: "t",
		server: "s",
		batchable: false,
		createdAt: new Date().toISOString(),
	};
	const fetch = async () => ({
		ok: true,
		status: 200,
		json: async () => ({ items: items.map((i) => ({ ...base, ...i })), rulings: [] }),
	});
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
		readFileSync(new URL("../web/static/app.js", import.meta.url), "utf8"),
	)(
		document,
		{ addEventListener: noop },
		{ pathname: "/" },
		{},
		() => ({ matches: false }),
		fetch,
		() => 0,
		noop,
		() => 0,
	);
	await new Promise((r) => setTimeout(r, 10));
	return app.innerHTML;
}

// ---- a thread's link on the full page: only the page's own /open route, never a card's raw link ----

export const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
