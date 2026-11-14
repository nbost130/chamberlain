/** inline-view, continued: see inline-view.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { type El, run, settle } from "../testing/inline-dom.ts";
import { buttons, card, item } from "../testing/web-inline-view-fixtures.ts";

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

describe("links out of the view", () => {
	const SRC = "http://queue.test/inline.js?view=decisions&k=KEY";
	const anchors = (dq: El) =>
		dq.all((e) => e.tag === "a").map((a) => ({ text: a.textContent, href: a.href, target: a.target }));
	test("a mirrored card links to the queue page and, through /open, to its thread: both http(s), neither carries a key (the view key cannot sign a browser in)", async () => {
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
			{ text: "Open the queue page", href: "http://queue.test/", target: "_blank" },
			{ text: "Open the thread", href: "http://queue.test/open/mac/mcp%3Alaunch%3Aab12", target: "_blank" },
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
			{ text: "Open the thread", href: "http://queue.test/open/mithrandir/t1", target: "_blank" },
		]);
	});
	test("a secret or a card pointer, answered in its thread, links to that thread and can be snoozed in place, nothing more", async () => {
		const base = { ...item("x"), open: "/open/mac/t2" };
		for (const extra of [{ secret: true }, { cardRequest: { requestId: "r" } }]) {
			const dq = run(() => ({ items: [{ ...base, ...extra }] }), { src: SRC });
			await settle();
			expect(anchors(dq).map((a) => [a.text, a.href])).toEqual([["Open the thread", "http://queue.test/open/mac/t2"]]);
			expect(buttons(dq)).toEqual(["Snooze"]);
		}
	});
	test("no /open path, no thread link: never a raw t3-thread:// or other custom-scheme href, which the frame cannot open", async () => {
		const c = { ...card("make", "sig-1"), link: "t3-thread://v2/env/t" };
		const q = { ...item("x"), link: "t3-thread://v2/env/t", open: "t3code://threads/env/t" };
		const dq = run(() => ({ items: [q], cards: [c] }), { src: SRC });
		await settle();
		const hrefs = anchors(dq).map((a) => a.href);
		expect(anchors(dq).map((a) => a.text)).toEqual(["Open the queue page"]);
		expect(hrefs[0]).toBe("http://queue.test/");
		expect(hrefs.every((h) => h.startsWith("http://queue.test/"))).toBe(true);
	});
});

// ---- inside T3's phone app: the view is the top document of the app's web view, so a thread opens in the app, no browser ----

describe("the thread link inside T3's phone app", () => {
	const SRC = "http://queue.test/inline.js?view=decisions&k=KEY";
	const APP = "t3code://threads/env-home/11111111-2222-3333-4444-555555555555";
	/** The phone app's web view: this page is its top document. */
	const top = () => {
		const w: { parent?: unknown } = {};
		w.parent = w;
		return w;
	};
	/** T3's web and desktop clients: a sandboxed frame inside the app's page. */
	const framed = () => ({ parent: {} });
	const anchors = (dq: El) =>
		dq.all((e) => e.tag === "a").map((a) => ({ text: a.textContent, href: a.href, target: a.target }));
	const q = { ...item("x"), server: "mithrandir", threadId: "t1", open: "/open/mithrandir/t1", app: APP };
	test("at the top of T3's web view, a question's thread link is the app link itself, opened in place (no new window)", async () => {
		const dq = run(() => ({ items: [q] }), { src: SRC, window: top() });
		await settle();
		expect(anchors(dq)).toEqual([{ text: "Open the thread", href: APP, target: "" }]);
	});
	test("a mirrored card and a secret question get the app link too; the queue page link stays the page's own", async () => {
		const c = { ...card("make", "sig-1"), open: "/open/main/t", app: APP };
		const s = { ...q, secret: true };
		const dq = run(() => ({ items: [s], cards: [c] }), { src: SRC, window: top() });
		await settle();
		expect(anchors(dq)).toEqual([
			{ text: "Open the thread", href: APP, target: "" },
			{ text: "Open the queue page", href: "http://queue.test/", target: "_blank" },
			{ text: "Open the thread", href: APP, target: "" },
		]);
	});
	test("in a frame (T3's web and desktop clients), the link goes through /open, which the frame can open", async () => {
		for (const window of [
			framed(),
			undefined,
			{
				get parent() {
					throw Error("cross-origin");
				},
			},
		]) {
			const dq = run(() => ({ items: [q] }), { src: SRC, window });
			await settle();
			expect(anchors(dq)).toEqual([
				{ text: "Open the thread", href: "http://queue.test/open/mithrandir/t1", target: "_blank" },
			]);
		}
	});
	test("an app link of any other shape is never an href: the view falls back to /open, or no link", async () => {
		for (const app of [
			"javascript://threads/%0aalert(1)",
			"javascript:alert(1)",
			"JavaScript://x/y",
			"data://text/html,x",
			"vbscript://x",
			"file:///etc/passwd",
			"https://evil.example/t",
			"t3code:threads/e/t",
			" t3code://threads/e/t",
			't3code://threads/e/t"><img src=x onerror=alert(1)>',
			"T3CODE://threads/e/t",
			`t3code://${"a".repeat(1100)}`,
			42,
			{ toString: () => APP },
		]) {
			const dq = run(
				() => ({
					items: [
						{ ...q, app },
						{ ...q, id: "Q-ctx2", app, open: undefined },
					],
				}),
				{
					src: SRC,
					window: top(),
				},
			);
			await settle();
			expect([app, anchors(dq).map((a) => a.href)]).toEqual([app, ["http://queue.test/open/mithrandir/t1"]]);
		}
	});
});

describe("a secret question whose secret box has closed", () => {
	const secret = (over: Record<string, unknown> = {}) => ({ ...item("x"), secret: true, open: "/open/m/t1", ...over });
	test("says the request expired and to ask the thread to reopen it, instead of pointing at a box that is gone", async () => {
		const dq = run(() => ({ items: [secret({ secretRequest: "ended" })] }));
		await settle();
		expect(dq.textContent).toContain("Request expired. Its secret box is closed: ask the thread to reopen it.");
		expect(dq.textContent).not.toContain("A secret is entered in its own thread");
		expect(dq.all((e) => e.tag === "a").map((a) => a.textContent)).toEqual(["Open the thread"]);
		expect(buttons(dq)).toEqual(["Snooze"]);
		expect(dq.all((e) => e.tag === "button" && e.className === "dq-go")).toEqual([]);
	});
	test("an open box, an unknown state or any other value reads as before", async () => {
		for (const state of ["open", undefined, "ENDED", "<b>ended</b>", true]) {
			const dq = run(() => ({ items: [secret({ secretRequest: state })] }));
			await settle();
			expect([state, dq.textContent.includes("A secret is entered in its own thread, never here.")]).toEqual([
				state,
				true,
			]);
			expect([state, dq.textContent.includes("Request expired")]).toEqual([state, false]);
		}
	});
	test("a plain question never shows the note, whatever it carries", async () => {
		const dq = run(() => ({ items: [{ ...item("x"), secretRequest: "ended" }] }));
		await settle();
		expect(dq.textContent).not.toContain("Request expired");
	});
});
