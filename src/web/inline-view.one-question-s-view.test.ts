/** inline-view, continued: see inline-view.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { run, settle } from "../testing/inline-dom.ts";
import { buttons, item } from "../testing/web-inline-view-fixtures.ts";

describe("one question's view (?item=) and the recent answers know snoozed and dismissed", () => {
	test("a snoozed question says when it returns and links to it on the full page", async () => {
		const later = {
			...item("x"),
			id: "Q-snz1",
			snooze: { until: "2026-11-15T09:00:00.000Z", at: "2026-11-14T12:00:00.000Z", active: true, returned: false },
		};
		const dq = run(() => ({ items: [], snoozed: [later] }), { src: "http://queue.test/inline.js?item=Q-snz1&k=KEY" });
		await settle();
		expect(dq.textContent).toContain("Snoozed. It returns ");
		expect(dq.querySelector(".dq-count")!.textContent).toBe("snoozed");
		// un-snoozing is not the view key's (src/web/view-key.ts): the link opens the full page
		expect(dq.all((e) => e.tag === "a").map((a) => [a.textContent, a.href])).toEqual([
			["Un-snooze", "http://queue.test/item/Q-snz1"],
		]);
		expect(buttons(dq)).toEqual([]);
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

test("the view's script posts only to the view key's four writes: answer, snooze, direction, dismiss", () => {
	const source = readFileSync(new URL("../web/static/inline.js", import.meta.url), "utf8");
	// the one POST goes to /api/items/<id>/<action>, and every action it is given is on the list in src/web/view-key.ts
	expect([...source.matchAll(/method:\s*"POST"/g)]).toHaveLength(1);
	expect([...new Set([...source.matchAll(/\bsend\("([a-z-]+)"/g)].map((m) => m[1]))].sort()).toEqual([
		"answer",
		"direction",
		"dismiss",
		"snooze",
	]);
	expect(source).not.toMatch(/\/(unsnooze|not-now|accept-all|cards\/|confirm)/);
	expect(source).not.toMatch(/api\/rulings\/|saveRuling|rulingWording/);
});
