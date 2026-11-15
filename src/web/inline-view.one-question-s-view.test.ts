/** inline-view, continued: see inline-view.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { run, settle } from "../testing/inline-dom.ts";
import { buttons, item } from "../testing/web-inline-view-fixtures.ts";
import { VIEW_KEY_WRITES } from "./view-key.ts";

describe("one question's view (?item=) and the recent answers know snoozed and dismissed", () => {
	test("a snoozed question says when it returns and un-snoozes in place: no link to the full page, which a phone's in-app browser cannot open", async () => {
		const later = {
			...item("x"),
			id: "Q-snz1",
			snooze: { until: "2026-11-15T09:00:00.000Z", at: "2026-11-14T12:00:00.000Z", active: true, returned: false },
		};
		const calls: { method: string; path: string; body?: unknown }[] = [];
		const dq = run(() => ({ items: [], snoozed: [later] }), {
			src: "http://queue.test/inline.js?item=Q-snz1&k=KEY",
			calls,
			post: () => ({ status: 200, body: { ok: true } }),
		});
		await settle();
		expect(dq.textContent).toContain("Snoozed. It returns ");
		expect(dq.querySelector(".dq-count")!.textContent).toBe("snoozed");
		expect(dq.all((e) => e.tag === "a").map((a) => a.href)).toEqual([]);
		expect(buttons(dq)).toEqual(["Un-snooze"]);
		const un = dq.all((e) => e.tag === "button" && e.textContent === "Un-snooze")[0]!;
		for (const fn of un.listeners.click ?? []) await fn();
		await settle();
		expect(calls.filter((c) => c.method === "POST")).toEqual([
			{ method: "POST", path: "/api/items/Q-snz1/unsnooze", body: {} },
		]);
		expect(dq.textContent).toContain("Back on the waiting list.");
	});
	test("a dismissed question says dismissed and that nothing was answered", async () => {
		const gone = {
			...item("x"),
			id: "Q-dis1",
			status: "dismissed",
			dismissal: { note: "handled in the thread", t: "2026-11-14T12:00:00.000Z" },
		};
		const dq = run(() => ({ items: [] }), {
			src: "http://queue.test/inline.js?item=Q-dis1&k=KEY",
			recent: () => ({ items: [gone] }),
		});
		await settle();
		expect(dq.textContent).toContain("Dismissed (handled in the thread). Nothing was answered.");
		expect(dq.querySelector(".dq-count")!.textContent).toBe("dismissed");
	});
	test("the Recent tab lists a dismissed question as dismissed, with its note, never with an answer's label", async () => {
		const gone = {
			...item("x"),
			id: "Q-dis1",
			status: "dismissed",
			dismissal: { note: "no longer needed", t: "2026-11-14T12:00:00.000Z" },
			at: "2026-11-14T12:00:00.000Z",
		};
		const dq = run(() => ({ items: [] }), {
			src: "http://queue.test/inline.js?view=decisions&k=KEY",
			recent: () => ({ items: [gone] }),
		});
		await settle();
		const recentTab = dq.all((e) => e.tag === "button" && e.textContent === "Recent")[0]!;
		for (const fn of recentTab.listeners.click ?? []) await fn();
		await settle();
		expect(dq.textContent).toContain("dismissed · no longer needed");
	});
});

test("the view's script posts only to the view key's writes: answer, snooze, un-snooze, direction, dismiss on an item, a question card's answer, and a mirrored card's dismiss", () => {
	const source = readFileSync(new URL("../web/static/inline.js", import.meta.url), "utf8");
	// the one POST goes through post(): /api/items/<id>/<action>, every action on the list in src/web/view-key.ts, or /api/cards/<id>/{answer,dismiss}
	expect([...source.matchAll(/method:\s*"POST"/g)]).toHaveLength(1);
	const named = [...source.matchAll(/\b(?:send|act)\("([a-z-]+)"/g)].map((m) => m[1]);
	expect([...new Set(named)].sort()).toEqual(["answer", "direction", "dismiss", "snooze", "unsnooze"]);
	expect(named.every((a) => (VIEW_KEY_WRITES as readonly string[]).includes(a!))).toBe(true);
	// each path with its template parts as "*"
	const paths = [...source.matchAll(/post\(`([^`]*)`/g)].map((m) => m[1]!.replace(/\$\{[^}]*\}/g, "*"));
	expect(paths).toEqual(["/api/items/*/*", "/api/cards/*/dismiss", "/api/cards/*/answer"]);
	expect(source).not.toMatch(/\/(unsnooze|not-now|accept-all|confirm)\b/);
	expect(source).not.toMatch(/api\/rulings\/|saveRuling|rulingWording/);
});
