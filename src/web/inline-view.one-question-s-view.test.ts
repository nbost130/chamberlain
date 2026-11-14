/** inline-view, continued: see inline-view.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { item, run, settle } from "../testing/web-inline-view-fixtures.ts";

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
		expect(dq.all((e) => e.tag === "a").map((a) => a.textContent)).toEqual(["Snooze"]);
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

test("the view's script never calls a route that changes an item's state: those are the full page's alone", () => {
	const source = readFileSync(new URL("./static/inline.js", import.meta.url), "utf8");
	expect(source).not.toMatch(/\/(snooze|unsnooze|direction|dismiss)["`'?]/);
	expect(source).not.toMatch(/api\/items\/[^"'`]*\/(snooze|unsnooze|direction|dismiss)/);
	// and the one POST it makes is the plain answer
	expect([...source.matchAll(/method:\s*"POST"/g)]).toHaveLength(1);
});
