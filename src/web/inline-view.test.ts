/** Runs the Decisions view (static/inline.js) against a tiny in-memory DOM, to check what a refresh shows. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

class El {
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

function run(
	queue: () => unknown,
	o: {
		src?: string;
		recent?: () => unknown;
		calls?: { method: string; path: string; body?: unknown }[];
		/** Collects the headers each call sent. */
		headers?: Record<string, string>[];
		/** The status every reply has (default 200); a function is asked on each call. */
		status?: number | (() => number);
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
		readFileSync(new URL("./static/inline.js", import.meta.url), "utf8"),
	)(document, fetch, () => 0, URL);
	return dq;
}
const settle = () => new Promise((r) => setTimeout(r, 5));
test("health card shows context meter, preserves expanded evidence, and labels each elevated signal", async () => {
	const h = {
		at: new Date().toISOString(),
		verdict: "HAND OFF",
		tokens: 275000,
		replies: 20,
		breaks: 3,
		selfReads: 3,
		threadRereads: 0,
		elevated: ["format", "rereading"],
		unknown: [],
		report: "Evidence",
	};
	const dq = run(() => ({
		items: [],
		health: h,
		healthLimits: { context: 200000, compactContext: 350000, selfReads: 3, threadRereads: 4 },
	}));
	await settle();
	expect(dq.textContent).toContain("HAND OFF");
	const health = dq.querySelector(".dq-health")!;
	expect(health.tag).toBe("details");
	expect(health.open).toBe(false);
	const summary = health.querySelector("summary")!;
	expect(summary.textContent).toContain("275k / 350k");
	expect(summary.textContent).toContain("Slips 3/20");
	expect(summary.textContent).toContain("Reads 3 self · 0 repeat");
	expect(summary.textContent).toContain("Checked just now");
	expect(dq.all((e) => e.attrs.role === "meter")[0]!.attrs["aria-valuenow"]).toBe("275000");
	expect(dq.all((e) => e.className === "dq-health-fill")[0]!.style.width).toBe(`${(275 / 350) * 100}%`);
	expect(dq.textContent).toContain("350k compact at");
	expect(dq.all((e) => e.textContent === "↑ Above threshold")).toHaveLength(2);
	dq.querySelector("details")!.open = true;
	for (const fn of dq.all((e) => e.tag === "button" && e.textContent === "Refresh")[0]!.listeners.click ?? [])
		await fn();
	await settle();
	expect(dq.querySelector("details")!.open).toBe(true);
});
test("COMPACT shows compaction in the warning tone, not a hand-off", async () => {
	const h = {
		at: new Date().toISOString(),
		verdict: "COMPACT",
		tokens: 375000,
		replies: 20,
		breaks: 0,
		selfReads: 1,
		threadRereads: 0,
		elevated: ["context"],
		unknown: [],
		report: "Compaction needed",
	};
	const dq = run(() => ({
		items: [],
		health: h,
		healthLimits: { context: 200000, compactContext: 350000, selfReads: 3, threadRereads: 4 },
	}));
	await settle();
	expect(dq.querySelector(".dq-health-badge")!.textContent).toContain("COMPACT");
	expect(dq.textContent).not.toContain("HAND OFF");
	expect(dq.textContent).toContain("350k compact at");
	expect(dq.querySelector(".dq-health")!.style["--health-tone"]).toBe("var(--warning)");
});
test("missing health has no healthy badge or meter", async () => {
	const dq = run(() => ({ items: [], health: null }));
	await settle();
	expect(dq.textContent).toContain("AWAITING DATA");
	expect(dq.all((e) => e.attrs.role === "meter")).toHaveLength(0);
});
test("failed refresh cannot leave a cached OK reading green", async () => {
	let offline = false;
	const dq = run(() => {
		if (offline) throw Error("offline");
		return {
			items: [],
			health: {
				at: new Date().toISOString(),
				verdict: "OK",
				tokens: 100,
				replies: 1,
				breaks: 0,
				selfReads: 0,
				threadRereads: 0,
				unknown: [],
			},
		};
	});
	await settle();
	expect(dq.querySelector(".dq-health-badge")!.textContent).toContain("OK");
	offline = true;
	for (const fn of dq.all((e) => e.tag === "button" && e.textContent === "Refresh")[0]!.listeners.click ?? [])
		await fn();
	await settle();
	expect(dq.querySelector(".dq-health-badge")!.textContent).toContain("LIMITED DATA");
	expect(dq.querySelector(".dq-health")!.style["--health-tone"]).toBe("var(--warning)");
	expect(dq.querySelector(".dq-health-summary")!.textContent).toContain("0k tokens");
});
test("Decisions shows health report and marks old measurements stale", async () => {
	const dq = run(() => ({
		items: [],
		health: { verdict: "HAND OFF", at: "2020-01-01T00:00:00Z", report: "Context: 251000; compact >350000" },
	}));
	await settle();
	expect(dq.textContent).toContain("STALE");
	expect(dq.textContent).toContain("Last known status: HAND OFF");
	expect(dq.textContent).toContain("Context: 251000; compact >350000");
});
const card = (prompt: string, sig: string) => ({
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

test("a refresh redraws an approval whose command changed under the same ID", async () => {
	let current = card("true", "sig-1");
	const dq = run(() => ({ items: [], cards: [current] }));
	await settle();
	const cmd = () => dq.all((e) => e.tag === "pre").map((e) => e.textContent);
	expect(cmd()).toEqual(["true"]);
	current = card("true;", "sig-2");
	const refresh = dq.all((e) => e.textContent === "Refresh" && e.tag === "button")[0]!;
	for (const fn of refresh.listeners.click ?? []) await fn();
	await settle();
	expect(cmd()).toEqual(["true;"]);
	expect(dq.all((e) => e.className.includes("dq-card"))).toHaveLength(1);
});

test("an unchanged card is kept as it is across a refresh, so a pick in progress survives", async () => {
	const dq = run(() => ({ items: [], cards: [card("true", "sig-1")] }));
	await settle();
	const first = dq.all((e) => e.className.includes("dq-card"))[0];
	const refresh = dq.all((e) => e.textContent === "Refresh" && e.tag === "button")[0]!;
	for (const fn of refresh.listeners.click ?? []) await fn();
	await settle();
	expect(dq.all((e) => e.className.includes("dq-card"))[0]).toBe(first!);
});

test("Waiting says which machine can't be reached, and drops the line once it is back", async () => {
	let away = [{ server: "laptop", since: "2026-11-10T14:12:00Z" }];
	const dq = run(() => ({ items: [], cards: [], unreachable: away }));
	await settle();
	expect(dq.textContent).toContain("Laptop not reachable since");
	expect(dq.textContent).toContain("Nothing waiting");
	away = [];
	const refresh = dq.all((e) => e.textContent === "Refresh" && e.tag === "button")[0]!;
	for (const fn of refresh.listeners.click ?? []) await fn();
	await settle();
	expect(dq.textContent).not.toContain("not reachable");
});

const item = (context: string) => ({
	id: "Q-ctx1",
	kind: "product",
	title: "T",
	context,
	options: [{ label: "A" }, { label: "B" }],
	recommended: 0,
	status: "open",
	createdAt: new Date().toISOString(),
});
async function ctxOf(context: string) {
	const dq = run(() => ({ items: [item(context)] }));
	await settle();
	return dq;
}
test("context bullets render as one list with the prefix stripped", async () => {
	const dq = await ctxOf("Intro\n- a\n- b");
	const uls = dq.all((e) => e.tag === "ul");
	expect(uls).toHaveLength(1);
	expect(uls[0]!.children.map((li) => li.tag)).toEqual(["li", "li"]);
	expect(uls[0]!.children.map((li) => li.textContent)).toEqual(["a", "b"]);
	expect(dq.all((e) => e.tag === "p").map((p) => p.textContent)).toEqual(["Intro"]);
});
test("context bullet text is never parsed as markup", async () => {
	const dq = await ctxOf("Intro\n- <img src=x onerror=alert(1)>");
	expect(dq.all((e) => e.tag === "img" && e.src === "")).toHaveLength(0);
	expect(dq.all((e) => e.tag === "li")[0]!.textContent).toBe("<img src=x onerror=alert(1)>");
});
test("single-line context renders exactly as a plain block, even if it starts with a dash", async () => {
	for (const text of ["Just one line", "- not a list"]) {
		const dq = await ctxOf(text);
		const ctx = dq.querySelector(".dq-ctx")!;
		expect(ctx.tag).toBe("div");
		expect(ctx.children).toHaveLength(0);
		expect(ctx.textContent).toBe(text);
		expect(dq.all((e) => e.tag === "ul")).toHaveLength(0);
	}
});
test("a paragraph line after a list is its own paragraph after the list", async () => {
	const ctx = (await ctxOf("- a\nTail")).querySelector(".dq-ctx")!;
	expect(ctx.children.map((c) => c.tag)).toEqual(["ul", "p"]);
	expect(ctx.children[1]!.textContent).toBe("Tail");
});

// ---- what the inline view asks the server for (the server allows no more: inlineVerdict in app.ts) ----

const INLINE_PATHS = new Set(["/api/queue", "/api/recent", "/api/rulings"]);
test("a mirrored card or approval is shown read-only: no option to pick, no button, no request to answer it", async () => {
	const calls: { method: string; path: string }[] = [];
	const q = { ...card("rm -rf build", "sig-1") };
	const qc = {
		...card("", "sig-2"),
		id: "C-ba9876543210",
		type: "question",
		requestId: "q1",
		options: [{ label: "Yes" }, { label: "No" }],
	};
	const dq = run(() => ({ items: [], cards: [q, qc] }), { calls });
	await settle();
	expect(dq.textContent).toContain("Approvals and goals are answered on the full queue page, never here.");
	expect(dq.textContent).toContain("Answer this question card on the full queue page.");
	// The command is still shown exactly, so it can be read; but nothing here can approve it.
	expect(dq.all((e) => e.tag === "pre").map((e) => e.textContent)).toEqual(["rm -rf build"]);
	expect(dq.all((e) => e.tag === "input")).toHaveLength(0);
	expect(dq.all((e) => e.className.includes("dq-go"))).toHaveLength(0);
	expect(dq.all((e) => e.tag === "a" && e.href === "http://queue.test/")).toHaveLength(2);
	expect(calls.every((c) => c.method === "GET" && INLINE_PATHS.has(c.path))).toBe(true);
});

test("a single-question view reads only the queue and recent answers, never /api/items/<id>", async () => {
	const calls: { method: string; path: string }[] = [];
	const answered = { id: "Q-ctx2", kind: "product", title: "Done one", status: "answered", answer: { label: "A" } };
	const dq = run(() => ({ items: [item("x")] }), {
		src: "http://queue.test/inline.js?item=Q-ctx2",
		calls,
		recent: () => ({ items: [answered] }),
	});
	await settle();
	expect(dq.textContent).toContain("Answered: A.");
	const open = run(() => ({ items: [item("x")] }), { src: "http://queue.test/inline.js?item=Q-ctx1", calls });
	await settle();
	expect(open.all((e) => e.tag === "textarea")).toHaveLength(1);
	expect(calls.length).toBeGreaterThan(0);
	expect(calls.every((c) => c.method === "GET" && INLINE_PATHS.has(c.path))).toBe(true);
});
test("(a) a non-urgent question's card says NOT URGENT; an urgent one does not", async () => {
	const base = {
		kind: "product",
		context: "",
		options: [{ label: "A" }, { label: "B" }],
		status: "open",
		thread: "t",
		server: "s",
		createdAt: new Date().toISOString(),
	};
	const dq = run(() => ({
		items: [
			{ ...base, id: "Q-urg001", title: "Urgent one" },
			{ ...base, id: "Q-nu0001", title: "Can wait", urgent: false },
		],
	}));
	await settle();
	const kinds = dq.all((e) => e.className.split(" ").includes("dq-kind")).map((e) => e.textContent);
	expect(kinds.filter((k) => k.endsWith(" · NOT URGENT"))).toHaveLength(1);
	expect(kinds.some((k) => !k.includes("NOT URGENT"))).toBe(true);
});

test("the view sends the page's key from its own script address on every call, and carries it on the links it makes", async () => {
	const headers: Record<string, string>[] = [];
	const calls: { method: string; path: string }[] = [];
	const KEY = "k-test-0123456789abcdefghijklmnopqrstuvwxyz";
	const it = {
		...item("x"),
		evidence: [{ type: "image", path: "shot.png", caption: "a shot" }],
	};
	const dq = run(() => ({ items: [it] }), {
		src: `http://queue.test/inline.js?view=decisions&k=${KEY}`,
		calls,
		headers,
	});
	await settle();
	expect(calls.length).toBeGreaterThan(0);
	expect(headers).toHaveLength(calls.length);
	expect(headers.every((h) => h["x-decision-token"] === KEY)).toBe(true);
	// an <img> cannot send a header, so its address carries the key; "Open the queue page" does too, and opens signed in
	const imgs = dq.all((e) => e.tag === "img");
	expect(imgs.length).toBeGreaterThan(0);
	expect(imgs.every((i) => i.src.endsWith(`/shot.png?k=${KEY}`))).toBe(true);
});

test("a mirrored card's 'Open the queue page' link opens signed in, with the key from the script address", async () => {
	const KEY = "k-test-0123456789abcdefghijklmnopqrstuvwxyz";
	const dq = run(() => ({ items: [], cards: [card("rm -rf build", "sig-1")] }), {
		src: `http://queue.test/inline.js?view=decisions&k=${KEY}`,
	});
	await settle();
	expect(dq.all((e) => e.tag === "a" && e.href === `http://queue.test/?k=${KEY}`)).toHaveLength(1);
});

test("a view whose key was rotated says so, instead of showing an empty queue", async () => {
	const dq = run(() => ({ items: [] }), { src: "http://queue.test/inline.js?view=decisions&k=old", status: 401 });
	await settle();
	expect(dq.textContent).toContain("key no longer works");
	expect(dq.textContent).toContain("chamberlain web link");
	expect(dq.textContent).not.toContain("Nothing waiting");
});

test("a rotation that comes on a refresh, with questions on screen, is said so in a banner that stays", async () => {
	let status = 200;
	const dq = run(() => ({ items: [item("x")] }), {
		src: "http://queue.test/inline.js?view=decisions&k=old",
		status: () => status,
	});
	await settle();
	expect(dq.all((e) => e.tag === "textarea").length).toBeGreaterThan(0); // the card is showing
	expect(dq.textContent).not.toContain("key no longer works");
	status = 401; // the key was rotated since
	const refresh = dq.all((e) => e.className.split(" ").includes("dq-reload"))[0]!;
	for (const f of refresh.listeners.click ?? []) await f();
	await settle();
	expect(dq.all((e) => e.className.split(" ").includes("dq-locked"))).toHaveLength(1);
	expect(dq.textContent).toContain("chamberlain web link");
	for (const f of refresh.listeners.click ?? []) await f(); // a second refresh does not stack a second banner
	await settle();
	expect(dq.all((e) => e.className.split(" ").includes("dq-locked"))).toHaveLength(1);
});

// ---- links out of the view: T3 Code's frame opens only http(s), so each one is the page's own address, signed with ?k= ----

describe("links out of the view", () => {
	const SRC = "http://queue.test/inline.js?view=decisions&k=KEY";
	const anchors = (dq: El) =>
		dq.all((e) => e.tag === "a").map((a) => ({ text: a.textContent, href: a.href, target: a.target }));
	test("a mirrored card links to the queue page and, through /open, to its thread: both http(s), both signed in", async () => {
		const c = {
			...card("make", "sig-1"),
			server: "mac",
			threadId: "mcp:launch:ab12",
			link: "t3-thread://v2/env-mac/mcp:launch:ab12",
			open: "/open/mac/mcp%3Alaunch%3Aab12",
		};
		const dq = run(() => ({ items: [], cards: [c] }), { src: SRC });
		await settle();
		expect(anchors(dq)).toEqual([
			{ text: "Open the queue page", href: "http://queue.test/?k=KEY", target: "_blank" },
			{ text: "Open the thread", href: "http://queue.test/open/mac/mcp%3Alaunch%3Aab12?k=KEY", target: "_blank" },
		]);
	});
	test("a question asked with chamberlain ask links to its thread too", async () => {
		const q = {
			...item("x"),
			server: "mithrandir",
			threadId: "t1",
			link: "t3-thread://v2/env-home/t1",
			open: "/open/mithrandir/t1",
		};
		const dq = run(() => ({ items: [q] }), { src: SRC });
		await settle();
		expect(anchors(dq)).toEqual([
			{ text: "Open the thread", href: "http://queue.test/open/mithrandir/t1?k=KEY", target: "_blank" },
		]);
	});
	test("a secret or a card pointer, answered in its thread, links to that thread", async () => {
		const base = { ...item("x"), open: "/open/mac/t2" };
		for (const extra of [{ secret: true }, { cardRequest: { requestId: "r" } }]) {
			const dq = run(() => ({ items: [{ ...base, ...extra }] }), { src: SRC });
			await settle();
			expect(anchors(dq).map((a) => a.href)).toEqual(["http://queue.test/open/mac/t2?k=KEY"]);
		}
	});
	test("no /open path, no thread link: never a raw t3-thread:// or other custom-scheme href, which the frame cannot open", async () => {
		const c = { ...card("make", "sig-1"), link: "t3-thread://v2/env/t" };
		const q = { ...item("x"), link: "t3-thread://v2/env/t", open: "t3code://threads/env/t" };
		const dq = run(() => ({ items: [q], cards: [c] }), { src: SRC });
		await settle();
		const hrefs = anchors(dq).map((a) => a.href);
		expect(hrefs).toEqual(["http://queue.test/?k=KEY"]);
		expect(hrefs.every((h) => h.startsWith("http://queue.test/"))).toBe(true);
	});
});
