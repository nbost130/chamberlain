/** A tiny in-memory DOM, and the Decisions view (src/web/static/inline.js) run against it: what the view's tests share. */
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
		/** The reply to a POST: its status and JSON body. Absent: a POST is answered like any call. */
		post?: (path: string, body: any) => { status: number; body: unknown } | undefined;
		/** The view's `window`. Absent: the script sees none, as no test before needed one (it reads as a frame). */
		window?: unknown;
		/** The shell has no `#dq` root: the view makes its own on the body (the returned element is that one). */
		noRoot?: boolean;
	} = {},
) {
	const body = new El("body");
	const dq = new El("div");
	if (!o.noRoot) body.append(dq);
	const document = {
		currentScript: { src: o.src ?? "http://queue.test/inline.js?view=decisions" },
		head: new El("head"),
		body,
		visibilityState: "visible",
		createElement: (t: string) => new El(t),
		getElementById: (id: string) => (id === "dq" && !o.noRoot ? dq : null),
	};
	const fetch = async (url: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
		const status = () => (typeof o.status === "function" ? o.status() : (o.status ?? 200));
		o.headers?.push(init?.headers ?? {});
		o.calls?.push({
			method: init?.method ?? "GET",
			path: new URL(url).pathname,
			...(init?.body ? { body: JSON.parse(init.body) } : {}),
		});
		// A POST is answered by `post` when the test gives one (its status and body), else as every call is.
		const posted =
			init?.method === "POST" ? o.post?.(new URL(url).pathname, init.body ? JSON.parse(init.body) : {}) : undefined;
		if (posted) return { ok: posted.status < 400, status: posted.status, json: async () => posted.body };
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
	return o.noRoot ? body.children[0]! : dq;
}
export const settle = () => new Promise((r) => setTimeout(r, 5));
