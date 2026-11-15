/**
 * A decision card's answer options are the main buttons; the actions every card has (Snooze, Dismiss, Direction, the thread link, Bring back now)
 * are a smaller, quieter row. Options carry `dq-main`, actions carry `dq-sec`, so the two can never share a style by accident. Run against the
 * in-memory DOM (src/testing/inline-dom.ts); what each button does is src/web/inline-act.test.ts.
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

describe("answer options and always-there actions get different classes", () => {
	test("each option is dq-main in its own dq-options row; Snooze, Dismiss, Direction and the thread link are dq-sec in dq-actions below it", async () => {
		const dq = run(() => ({ items: [item()] }), { src: SRC });
		await settle();
		const options = dq.all((e) => has(e, "dq-options"))[0]!;
		const actions = dq.all((e) => has(e, "dq-actions"))[0]!;
		expect(text(options.children)).toEqual(["Yes: allow /open for the view key", "No: keep /open full-key only"]);
		expect(options.children.every((b) => has(b, "dq-main") && !has(b, "dq-sec"))).toBe(true);
		expect(text(actions.children)).toEqual(["Snooze", "Dismiss", "Direction", "Open the thread"]);
		expect(actions.children.every((b) => has(b, "dq-sec") && !has(b, "dq-main"))).toBe(true);
		// the options row comes first, then the actions: they never share a row
		const card = actions.parent!;
		expect(card.children.indexOf(options)).toBeLessThan(card.children.indexOf(actions));
	});
	test("the recommended option is still the filled one (rec); the other keeps the outline style at the same large size", async () => {
		const dq = run(() => ({ items: [item()] }), { src: SRC });
		await settle();
		const [yes, no] = dq.all((e) => has(e, "dq-main"));
		expect(has(yes!, "rec") && has(yes!, "dq-main")).toBe(true);
		expect(has(no!, "rec")).toBe(false);
		expect(has(no!, "dq-main")).toBe(true);
		expect(dq.all((e) => has(e, "dq-sec") && has(e, "rec"))).toEqual([]);
	});
	test("a secret and a card pointer have no options row, and every button they do have is dq-sec", async () => {
		for (const extra of [{ secret: true, options: [] }, { cardRequest: "r1" }]) {
			const dq = run(() => ({ items: [item(extra)] }), { src: SRC });
			await settle();
			expect(dq.all((e) => has(e, "dq-options"))).toEqual([]);
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
	test("answering removes the options row, and what is left is the quiet thread link", async () => {
		const dq = run(() => ({ items: [item()] }), {
			src: SRC,
			post: () => ({ status: 200, body: { ok: true, choice: "Yes", to: "steward" } }),
		});
		await settle();
		for (const fn of dq.all((e) => has(e, "dq-main"))[0]!.listeners.click ?? []) await fn();
		await settle();
		expect(dq.all((e) => has(e, "dq-options"))).toEqual([]);
		expect(dq.all((e) => has(e, "dq-main"))).toEqual([]);
	});
});

describe("the stylesheet makes the options the bigger buttons", () => {
	const rule = (sel: string) => JS.match(new RegExp(`${sel.replace(/[.]/g, "\\.")}\\{([^}]*)\\}`))![1]!;
	const px = (r: string, prop: string) => Number(new RegExp(`${prop}:(\\d+)px`).exec(r)![1]);
	test("dq-main is bigger than dq-sec in height, font size and padding, and its long labels wrap inside the button", () => {
		const main = rule(".dq-btn.dq-main");
		const sec = rule(".dq-btn.dq-sec,.dq-pill.dq-sec");
		expect(px(main, "min-height")).toBeGreaterThanOrEqual(48);
		expect(px(main, "min-height")).toBeGreaterThan(px(sec, "min-height") + 12);
		expect(px(main, "font-size")).toBeGreaterThan(px(sec, "font-size"));
		expect(Number(/padding:(\d+)px/.exec(main)![1])).toBeGreaterThan(Number(/padding:(\d+)px/.exec(sec)![1]));
		expect(main).toContain("white-space:normal");
		expect(main).toContain("overflow-wrap:anywhere");
		expect(main).toContain("max-width:100%");
	});
	test("on a phone each option takes a whole row, so it is tapped on its own; a touch screen keeps a 40px target for the quiet row", () => {
		expect(JS).toMatch(/@media\(max-width:520px\)\{\.dq-btn\.dq-main\{flex:1 1 100%\}\}/);
		expect(JS).toMatch(/@media\(pointer:coarse\)\{\.dq-btn\.dq-sec,\.dq-pill\.dq-sec\{min-height:40px\}\}/);
	});
	test("the options row wraps and the tab row stays one row", () => {
		expect(rule(".dq-options")).toContain("flex-wrap:wrap");
		expect(rule(".dq-tabs")).toContain("flex-wrap:nowrap");
	});
});
