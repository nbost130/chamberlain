import { readFileSync } from "node:fs";

export class El {
	children: El[] = [];
	parent?: El;
	className = "";
	dataset: Record<string, string> = {};
	style: Record<string, any> = {
		setProperty: (key: string, value: string) => {
			this.style[key] = value;
		},
	};
	open = false;
	attrs: Record<string, string> = {};
	listeners: Record<string, (() => unknown)[]> = {};
	private text = "";
	type = "";
	name = "";
	checked = false;
	disabled = false;
	value = "";
	placeholder = "";
	rows = 0;
	href = "";
	target = "";
	rel = "";
	src = "";
	alt = "";
	constructor(public tag: string) {}
	get textContent(): string {
		return this.text + this.children.map((c) => c.textContent).join("");
	}
	set textContent(v: string) {
		this.text = String(v);
		this.children = [];
	}
	/** The leading text node: setting it changes only this element's own text, as in a real DOM. */
	get firstChild() {
		const self = this;
		return {
			get textContent() {
				return self.text;
			},
			set textContent(v: string) {
				self.text = v;
			},
		};
	}
	get classList() {
		return {
			add: (c: string) => {
				this.className += ` ${c}`;
			},
			toggle: (c: string, on: boolean) => {
				const set = new Set(this.className.split(" ").filter(Boolean));
				on ? set.add(c) : set.delete(c);
				this.className = [...set].join(" ");
			},
		};
	}
	append(...xs: El[]) {
		for (const x of xs) {
			x.parent = this;
			this.children.push(x);
		}
	}
	appendChild(x: El) {
		this.append(x);
		return x;
	}
	insertBefore(x: El, ref?: El) {
		x.parent = this;
		const i = ref ? this.children.indexOf(ref) : -1;
		i < 0 ? this.children.push(x) : this.children.splice(i, 0, x);
	}
	replaceChildren(...xs: El[]) {
		this.children = [];
		this.text = "";
		this.append(...xs);
	}
	replaceWith(x: El) {
		const p = this.parent!;
		x.parent = p;
		p.children[p.children.indexOf(this)] = x;
	}
	remove() {
		const p = this.parent;
		if (p) p.children = p.children.filter((c) => c !== this);
	}
	setAttribute(k: string, v: string) {
		this.attrs[k] = v;
	}
	addEventListener(ev: string, fn: () => unknown) {
		const list = this.listeners[ev] ?? [];
		this.listeners[ev] = list;
		list.push(fn);
	}
	all(pred: (e: El) => boolean): El[] {
		return [...(pred(this) ? [this] : []), ...this.children.flatMap((c) => c.all(pred))];
	}
	querySelector(sel: string): El | null {
		const cls = sel.startsWith(".") ? sel.slice(1) : undefined;
		return this.all((e) => (cls ? e.className.split(" ").includes(cls) : e.tag === sel))[0] ?? null;
	}
}

export function run(
	queue: () => unknown,
	o: {
		src?: string;
		recent?: () => unknown;
		calls?: { method: string; path: string; body?: unknown }[];
		/** Collects the headers each call sent. */
		headers?: Record<string, string>[];
		/** The status every reply has (default 200); a function is asked on each call. */
		status?: number | (() => number);
		/** The view's `window`. Absent: the script sees none, as no test before needed one (it reads as a frame). */
		window?: unknown;
	} = {},
) {
	const body = new El("body");
	const dq = new El("div");
	body.append(dq);
	const document = {
		currentScript: { src: o.src ?? "http://queue.test/inline.js?view=decisions" },
		head: new El("head"),
		body,
		visibilityState: "visible",
		createElement: (t: string) => new El(t),
		getElementById: (id: string) => (id === "dq" ? dq : null),
	};
	const fetch = async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
		const status = () => (typeof o.status === "function" ? o.status() : (o.status ?? 200));
		o.headers?.push(init?.headers ?? {});
		o.calls?.push({
			method: init?.method ?? "GET",
			path: new URL(url).pathname,
			...(init?.body ? { body: JSON.parse(init.body) } : {}),
		});
		return {
			ok: status() < 400,
			status: status(),
			json: async () =>
				url.endsWith("/api/queue")
					? queue()
					: url.endsWith("/api/recent") && o.recent
						? o.recent()
						: { items: [], rulings: [] },
		};
	};
	new Function(
		"document",
		"fetch",
		"setInterval",
		"URL",
		"window",
		readFileSync(new URL("../web/static/inline.js", import.meta.url), "utf8"),
	)(document, fetch, () => 0, URL, o.window);
	return dq;
}

export const settle = () => new Promise((r) => setTimeout(r, 5));

export const card = (prompt: string, sig: string) => ({
	id: "C-0123456789ab",
	type: "approval",
	server: "main",
	threadId: "t",
	threadTitle: "T",
	requestId: "a1",
	header: "Approval",
	question: "command",
	command: prompt,
	options: [{ label: "Approve once" }, { label: "Decline" }],
	answerable: true,
	sig,
});

export const item = (context: string) => ({
	id: "Q-ctx1",
	kind: "product",
	title: "T",
	context,
	options: [{ label: "A" }, { label: "B" }],
	recommended: 0,
	status: "open",
	createdAt: new Date().toISOString(),
});

export async function ctxOf(context: string) {
	const dq = run(() => ({ items: [item(context)] }));
	await settle();
	return dq;
}

// ---- what the inline view asks the server for (the server allows no more: inlineVerdict in app.ts) ----

export const INLINE_PATHS = new Set(["/api/queue", "/api/recent", "/api/rulings"]);

// ---- links out of the view: T3 Code's frame opens only http(s), so each one is the page's own address, signed with ?k= ----

/** The three buttons after the thread link on a queue item: this frame cannot do them, so each opens the item on the full page, signed in. */
export const settleLinks = (id: string, only: string[] = ["Snooze", "Direction", "Dismiss"]) =>
	only.map((text) => ({ text, href: `http://queue.test/item/${id}`, target: "_blank" }));
