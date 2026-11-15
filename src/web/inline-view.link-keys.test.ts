/**
 * Which link out of the Decisions view carries a key (src/web/static/inline.js `linkOut`): the thread link, `/open/<server>/<threadId>`, and only
 * that one, and only the VIEW key the script already holds in its own address (the server accepts it on /open alone: src/web/view-key.ts). Every
 * other link out carries none, so a key is never in an address the server would not take it on. Run against the in-memory DOM (src/testing/inline-dom.ts).
 */
import { describe, expect, test } from "bun:test";
import { type El, run, settle } from "../testing/inline-dom.ts";
import { card, item } from "../testing/web-inline-view-fixtures.ts";

const KEY = "view-key-0123456789abcdefghijklmnopqrstuvwxyz";
const SRC = `http://queue.test/inline.js?view=decisions&k=${KEY}`;
const APP = "t3code://threads/env-home/t1";
const hrefs = (dq: El) => dq.all((e) => e.tag === "a").map((a) => [a.textContent, a.href]);
const threadItem = { ...item("x"), server: "mithrandir", threadId: "t1", open: "/open/mithrandir/t1", app: APP };
const snoozed = {
	...item("why it was put off"),
	id: "Q-snz1",
	title: "Snoozed Q-snz1",
	open: "/open/main/t1",
	snooze: { until: "2026-11-15T09:00:00.000Z", at: "2026-11-14T12:00:00.000Z", active: true, returned: false },
};
const mirrored = { ...card("make", "sig-1"), server: "mac", threadId: "t2", open: "/open/mac/t2" };

describe("the view's links out", () => {
	test("in a frame: the thread link carries the view key, as `?k=` on /open; every other link carries no key at all", async () => {
		const dq = run(() => ({ items: [threadItem], cards: [mirrored], snoozed: [snoozed] }), {
			src: SRC,
			window: { parent: {} },
		});
		await settle();
		const links = hrefs(dq);
		const open = links.filter(([, h]) => h?.includes("/open/"));
		const rest = links.filter(([, h]) => !h?.includes("/open/"));
		expect(open.length).toBeGreaterThan(0);
		for (const [text, h] of open) expect([text, h?.endsWith(`?k=${encodeURIComponent(KEY)}`)]).toEqual([text, true]);
		expect(rest.length).toBeGreaterThan(0); // "Open the queue page" at least
		for (const [text, h] of rest) expect([text, h?.includes(KEY), h?.includes("k=")]).toEqual([text, false, false]);
	});
	test("the key on /open is the script's own address key, in the one place: never anywhere but that href's query", async () => {
		const dq = run(() => ({ items: [threadItem] }), { src: SRC, window: { parent: {} } });
		await settle();
		expect(hrefs(dq)).toEqual([
			["Open the thread", `http://queue.test/open/mithrandir/t1?k=${encodeURIComponent(KEY)}`],
		]);
		const all = dq.all(() => true);
		const withKey = all.filter((e) => JSON.stringify([e.href, e.attrs, e.textContent]).includes(KEY));
		expect(withKey.map((e) => e.tag)).toEqual(["a"]);
	});
	test("a view with no key in its address puts none on any link, /open included", async () => {
		const dq = run(() => ({ items: [threadItem], snoozed: [snoozed] }), {
			src: "http://queue.test/inline.js?view=decisions",
			window: { parent: {} },
		});
		await settle();
		for (const [text, h] of hrefs(dq)) expect([text, h?.includes("k=")]).toEqual([text, false]);
	});
	test("at the top of T3's phone app the thread link is the app link, with no key: only a /open address carries one", async () => {
		const w: { parent?: unknown } = {};
		w.parent = w;
		const dq = run(() => ({ items: [threadItem], cards: [mirrored] }), { src: SRC, window: w });
		await settle();
		const links = hrefs(dq);
		expect(links.map(([, h]) => h)).toContain(APP);
		for (const [text, h] of links.filter(([, h]) => !h?.includes("/open/")))
			expect([text, h?.includes(KEY)]).toEqual([text, false]);
	});
});
