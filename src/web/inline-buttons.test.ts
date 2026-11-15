/**
 * A decision card's buttons are one row across the card (dq-actions), wrapping only when the width runs out: the answer options first (dq-main), only
 * slightly bigger than the rest, then the actions every card has (dq-sec: Snooze, Dismiss, Direction, the thread link, Bring back now). Nathan,
 * 2026-11-15, undoing the large separate options row of #56. The full queue page does the same (app-buttons.test.ts). Run against the in-memory DOM
 * (src/testing/inline-dom.ts); what each button does is src/web/inline-act.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type El, run, settle } from "../testing/inline-dom.ts";

const SRC = "http://queue.test/inline.js?view=decisions&k=VIEWKEY";
const JS = readFileSync(new URL("./static/inline.js", import.meta.url), "utf8");
const item = (over: Record<string, unknown> = {}) => ({
	id: "Q-btn1",
	kind: "product",
	title: "Which one?",
	options: [{ label: "Yes: allow /open for the view key" }, { label: "No: keep /open full-key only" }],
	recommended: 0,
	status: "open",
	createdAt: new Date().toISOString(),
	open: "/open/main/t1",
	...over,
});
const has = (e: El, cls: string) => e.className.split(" ").includes(cls);
const buttons = (dq: El) => dq.all((e) => e.tag === "button" && has(e, "dq-btn"));
const text = (xs: El[]) => xs.map((x) => x.textContent);

describe("answer options and always-there actions share one row", () => {
	test("the options (dq-main) then Snooze, Dismiss, Direction and the thread link (dq-sec), all in the one dq-actions row", async () => {
		const dq = run(() => ({ items: [item()] }), { src: SRC });
		await settle();
		const rows = dq.all((e) => has(e, "dq-actions"));
		expect(rows).toHaveLength(1);
		expect(dq.all((e) => has(e, "dq-options"))).toEqual([]);
		const row = rows[0]!.children;
		expect(text(row)).toEqual([
			"Yes: allow /open for the view key",
			"No: keep /open full-key only",
			"Snooze",
			"Dismiss",
			"Direction",
			"Open the thread",
		]);
		expect(row.slice(0, 2).every((b) => has(b, "dq-main") && !has(b, "dq-sec"))).toBe(true);
		expect(row.slice(2).every((b) => has(b, "dq-sec") && !has(b, "dq-main"))).toBe(true);
	});
	test("the recommended option is still the filled one (rec); the other keeps the outline style at the same size", async () => {
		const dq = run(() => ({ items: [item()] }), { src: SRC });
		await settle();
		const [yes, no] = dq.all((e) => has(e, "dq-main"));
		expect(has(yes!, "rec") && has(yes!, "dq-main")).toBe(true);
		expect(has(no!, "rec")).toBe(false);
		expect(has(no!, "dq-main")).toBe(true);
		expect(dq.all((e) => has(e, "dq-sec") && has(e, "rec"))).toEqual([]);
	});
	test("a secret and a card pointer have no options, and every button they do have is dq-sec", async () => {
		for (const extra of [{ secret: true, options: [] }, { cardRequest: "r1" }]) {
			const dq = run(() => ({ items: [item(extra)] }), { src: SRC });
			await settle();
			expect(dq.all((e) => has(e, "dq-main"))).toEqual([]);
			expect(buttons(dq).every((b) => has(b, "dq-sec"))).toBe(true);
		}
	});
	test("a snoozed card's Bring back now, Dismiss and thread link are all dq-sec", async () => {
		const snoozed = {
			...item({ id: "Q-snz1", thread: "Mobile app", threadId: "t1" }),
			snooze: { until: "2026-11-15T09:00:00.000Z", active: true },
		};
		const dq = run(() => ({ items: [], snoozed: [snoozed] }), { src: SRC });
		await settle();
		const row = dq.all((e) => has(e, "dq-actions"))[0]!;
		expect(text(row.children)).toEqual(["Bring back now", "Dismiss", "Open the thread"]);
		expect(row.children.every((b) => has(b, "dq-sec"))).toBe(true);
	});
	test("answering takes the options out of the row, and what is left is the quiet thread link", async () => {
		const dq = run(() => ({ items: [item()] }), {
			src: SRC,
			post: () => ({ status: 200, body: { ok: true, choice: "Yes", to: "steward" } }),
		});
		await settle();
		for (const fn of dq.all((e) => has(e, "dq-main"))[0]!.listeners.click ?? []) await fn();
		await settle();
		expect(dq.all((e) => has(e, "dq-main"))).toEqual([]);
		expect(text(dq.all((e) => has(e, "dq-actions"))[0]!.children)).toEqual(["Open the thread"]);
	});
});

describe("the stylesheet makes the options only slightly bigger", () => {
	const rule = (sel: string) => JS.match(new RegExp(`${sel.replace(/[.()]/g, "\\$&")}\\{([^}]*)\\}`))![1]!;
	const px = (r: string, prop: string) => Number(new RegExp(`${prop}:(\\d+)px`).exec(r)![1]);
	test("dq-main is a little bigger than dq-sec (a few px of height, at most 2px of font), not the large size of #56, and long labels wrap inside it", () => {
		const main = rule(".dq-btn.dq-main");
		const sec = rule(".dq-btn.dq-sec,.dq-pill.dq-sec");
		const dh = px(main, "min-height") - px(sec, "min-height");
		const df = px(main, "font-size") - px(sec, "font-size");
		expect(dh).toBeGreaterThan(0);
		expect(dh).toBeLessThanOrEqual(6);
		expect(df).toBeGreaterThan(0);
		expect(df).toBeLessThanOrEqual(2);
		expect(px(main, "min-height")).toBeLessThan(48);
		expect(main).toContain("white-space:normal");
		expect(main).toContain("overflow-wrap:anywhere");
		expect(main).toContain("max-width:100%");
	});
	test("no rule makes an option a whole row on a phone; a touch screen keeps the option a little bigger than the 40px quiet row", () => {
		expect(JS).not.toMatch(/dq-main\{flex:1 1 100%\}/);
		expect(JS).toMatch(
			/@media\(pointer:coarse\)\{\.dq-btn\.dq-sec,\.dq-pill\.dq-sec\{min-height:40px\}\.dq-btn\.dq-main\{min-height:44px\}\}/,
		);
	});
	test("the one row wraps and the tab row stays one row", () => {
		expect(rule(".dq-actions")).toContain("flex-wrap:wrap");
		expect(rule(".dq-tabs")).toContain("flex-wrap:nowrap");
	});
});
