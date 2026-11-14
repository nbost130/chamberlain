/** Runs the queue page (static/app.js) against stubbed browser globals, to check how an item's context renders. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

async function detail(context: string, over: Record<string, unknown> = {}): Promise<string> {
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
		readFileSync(new URL("./static/app.js", import.meta.url), "utf8"),
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

test("context bullets render as one list with the prefix stripped", async () => {
	const html = await detail("Intro\n- a\n- b");
	expect(html.match(/<ul>/g)).toHaveLength(1);
	expect(html).toContain('<div class="context"><p>Intro</p><ul><li>a</li><li>b</li></ul></div>');
});
test("context bullet text is escaped", async () => {
	const html = await detail("Intro\n- <img src=x onerror=alert(1)>");
	expect(html).toContain("<li>&lt;img src=x onerror=alert(1)&gt;</li>");
	expect(html).not.toContain("<img src=x");
});
test("single-line context renders exactly as before", async () => {
	expect(await detail("Just one line")).toContain('<p class="context">Just one line</p>');
	const dash = await detail("- not a list");
	expect(dash).toContain('<p class="context">- not a list</p>');
	expect(dash).not.toContain("<ul>");
});
test("a paragraph line after a list is its own paragraph after the list", async () => {
	expect(await detail("- a\nTail")).toContain('<div class="context"><ul><li>a</li></ul><p>Tail</p></div>');
});

// ---- the full page asks the server for the approval's confirmation, and presents it ----

/** The page with a card in the queue: its clicks and changes can be fired, and every request it makes is recorded. */
async function cardPage(cards: unknown[], reply: (path: string, body: any) => { status?: number; json: unknown }) {
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
		readFileSync(new URL("./static/app.js", import.meta.url), "utf8"),
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
const approval = {
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

test("an approval takes two taps: the first asks the server for a confirmation, the second presents it", async () => {
	const p = await cardPage([approval], (path) =>
		path.endsWith("/confirm")
			? {
					json: {
						ok: true,
						challenge: "chal-1",
						expiresAt: Date.now() + 60_000,
						expiresInMs: 60_000,
						decision: "Approve once",
					},
				}
			: { json: { ok: true, choice: "Approved once" } },
	);
	expect(p.app.innerHTML).toContain("rm -rf build");
	expect(p.app.innerHTML).toContain(">Approve once</button>");
	await p.click("answer", approval.id);
	// One tap sends nothing that could approve it: only the request for a confirmation.
	expect(p.calls).toEqual([{ path: `/api/cards/${approval.id}/confirm`, body: { choice: 0, sig: "sig-1" } }]);
	expect(p.app.innerHTML).toContain("Tap again to confirm: Approve once");
	await p.click("answer", approval.id);
	expect(p.calls[1]).toEqual({
		path: `/api/cards/${approval.id}/answer`,
		body: { choice: 0, sig: "sig-1", challenge: "chal-1" },
	});
	expect(p.app.innerHTML).not.toContain("rm -rf build");
});

test("changing the option cancels the confirmation, so the next tap asks for a new one for the new choice", async () => {
	const p = await cardPage([approval], (path) =>
		path.endsWith("/confirm")
			? { json: { ok: true, challenge: "chal-x", expiresAt: Date.now() + 60_000, expiresInMs: 60_000, decision: "x" } }
			: { json: { ok: true, choice: "Declined" } },
	);
	await p.click("answer", approval.id);
	await p.pick(approval.id, 1);
	expect(p.app.innerHTML).not.toContain("Tap again to confirm");
	await p.click("answer", approval.id);
	expect(p.calls.map((c) => [c.path.split("/").pop(), c.body.choice])).toEqual([
		["confirm", 0],
		["confirm", 1],
	]);
});

test("a refused answer shows the server's reason and starts over; a question card is answered in one tap", async () => {
	const p = await cardPage(
		[approval, { ...approval, id: "C-aaaaaaaaaaaa", type: "question", command: undefined }],
		(path) =>
			path.endsWith("/confirm")
				? { json: { challenge: "c", expiresAt: Date.now() + 60_000, expiresInMs: 60_000, decision: "x" } }
				: path.includes("aaaaaaaaaaaa")
					? { json: { ok: true, choice: "Approve once" } }
					: { status: 410, json: { error: "the confirmation expired: confirm again" } },
	);
	await p.click("answer", approval.id);
	await p.click("answer", approval.id);
	expect(p.app.innerHTML).not.toContain("Tap again to confirm");
	await p.click("answer", "C-aaaaaaaaaaaa");
	expect(p.calls.filter((c) => c.path.includes("aaaaaaaaaaaa")).map((c) => c.path.split("/").pop())).toEqual([
		"answer",
	]);
	expect(p.calls.find((c) => c.path.includes("aaaaaaaaaaaa"))!.body).toEqual({ choice: 0, sig: "sig-1" });
});

test("a secret or a link request is shown with where to answer it, and nothing to tap", async () => {
	const p = await cardPage(
		[
			{
				...approval,
				id: "C-eeeeeeeeeeee",
				type: "secret",
				answerable: false,
				why: "a secret is entered in its own thread",
				options: [],
				command: undefined,
			},
		],
		() => ({ json: {} }),
	);
	expect(p.app.innerHTML).toContain("a secret is entered in its own thread");
	expect(p.app.innerHTML).not.toContain('data-cact="answer"');
});

async function list(items: Record<string, unknown>[]): Promise<string> {
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
		readFileSync(new URL("./static/app.js", import.meta.url), "utf8"),
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

test("(a) a non-urgent question is listed below every urgent one, under NOT URGENT, and says so", async () => {
	const html = await list([
		{ id: "Q-nu-only", kind: "only-you", title: "Waits a while", urgent: false },
		{ id: "Q-idea1", kind: "idea", title: "An idea" },
		{ id: "Q-prod1", kind: "product", title: "A product call" },
	]);
	const at = (t: string) => html.indexOf(t);
	expect(at("A product call")).toBeGreaterThan(-1);
	expect(at("A product call")).toBeLessThan(at("An idea"));
	expect(at("An idea")).toBeLessThan(at("Waits a while"));
	expect(html).toMatch(/NOT URGENT · [^<]+/);
	expect(at("NOT URGENT")).toBeLessThan(at("Waits a while"));
	expect(html).toContain('<span class="later">not urgent</span>');
	expect(html.match(/not urgent<\/span>/g)).toHaveLength(1);
});
test("(a) a queue with no non-urgent question renders as before", async () => {
	const html = await list([{ id: "Q-prod1", kind: "product", title: "A product call" }]);
	expect(html).not.toContain("NOT URGENT");
	expect(html).not.toContain("not urgent");
});
test("(a) an approval, a secret and a card pointer stay under the urgent groups even when their row says urgent: false", async () => {
	const html = await list([
		{ id: "Q-apr01", kind: "only-you", title: "Approval row", tag: "Approval", urgent: false },
		{ id: "Q-sec01", kind: "only-you", title: "Secret row", secret: true, urgent: false },
		{ id: "Q-ptr01", kind: "only-you", title: "Pointer row", cardRequest: "req-1", tag: "Approval", urgent: false },
		{ id: "Q-nu001", kind: "idea", title: "Can wait row", urgent: false },
	]);
	const at = (t: string) => html.indexOf(t);
	for (const t of ["Approval row", "Secret row", "Pointer row"]) {
		expect(at(t)).toBeGreaterThan(-1);
		expect(at(t)).toBeLessThan(at("NOT URGENT"));
	}
	expect(at("NOT URGENT")).toBeLessThan(at("Can wait row"));
	expect(html.match(/not urgent<\/span>/g)).toHaveLength(1);
});

// ---- a thread's link on the full page: only the page's own /open route, never a card's raw link ----

const hrefs = (html: string) => [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]!);
test("a question links to its thread only through /open", async () => {
	const open = "/open/mac/11111111-2222-3333-4444-555555555555";
	const html = await detail("x", { link: "t3-thread://v2/env/t", open });
	expect(hrefs(html)).toContain(open);
	expect(hrefs(html).some((h) => h.startsWith("t3-thread:"))).toBe(false);
});
test("without /open, a custom-scheme or foreign link is never made an href", async () => {
	for (const link of ["t3-thread://v2/env/t", "https://outside.example/t", "javascript:alert(1)"]) {
		for (const extra of [{}, { cardRequest: { requestId: "r" } }, { secret: true }]) {
			const html = await detail("x", { link, ...extra });
			expect([link, hrefs(html).filter((h) => h === link || h.includes("outside") || h.includes(":"))]).toEqual([
				link,
				[],
			]);
		}
	}
	for (const open of [
		"https://outside.example/open/a/b",
		"//outside.example/open/a/b",
		"/open/a/b?x=https://e",
		"/elsewhere",
	]) {
		const html = await detail("x", { open });
		expect([open, hrefs(html).includes(open)]).toEqual([open, false]);
	}
});
test("a card read from a thread links only through /open, never its raw link", async () => {
	const foreign = { ...approval, link: "https://outside.example/t", answerable: false };
	const { app } = await cardPage(
		[foreign, { ...approval, id: "C-ba9876543210", link: "t3-thread://v2/e/t", open: "/open/main/t" }],
		() => ({ json: {} }),
	);
	const h = hrefs(app.innerHTML);
	expect(h).toContain("/open/main/t");
	expect(h.some((x) => x.includes("outside.example") || x.startsWith("t3-thread:"))).toBe(false);
});

test("a secret question whose secret box has closed says the request expired, not to enter it", async () => {
	const ended = await detail("c", { secret: true, secretRequest: "ended", options: [], open: "/open/s/t1" });
	expect(ended).toContain("Request expired. Its secret box is closed: ask the thread to reopen it.");
	expect(ended).not.toContain("Enter it in its own thread");
	for (const state of ["open", undefined, "<b>ended</b>"]) {
		const html = await detail("c", { secret: true, secretRequest: state, options: [] });
		expect([state, html.includes("Enter it in its own thread")]).toEqual([state, true]);
		expect([state, html.includes("Request expired")]).toEqual([state, false]);
	}
});

test("the thread link opens in this tab, so a tap the app does not take leaves the queue page in place", async () => {
	const html = await detail("c", { open: "/open/s/t1", secret: true, options: [] });
	// The link to the thread is a little button in the row along the bottom (Open thread, Snooze); the secret box keeps its own link too.
	expect(html).toContain('<a class="mini" href="/open/s/t1">Open thread</a>');
	expect(html).toContain('<a href="/open/s/t1">Open t in T3</a>');
	expect(html).not.toMatch(/href="\/open\/[^"]*" target=/);
});
