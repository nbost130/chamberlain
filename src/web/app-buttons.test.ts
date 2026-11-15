/**
 * The full queue page's buttons (static/app.css): Answer and Not now sit first in the one row of buttons along an item's bottom edge, only a little
 * bigger than the small ones beside them (Nathan, 2026-11-15, undoing the large Answer button of #56). The inline view does the same
 * (inline-buttons.test.ts); the row's order is queue-actions-view.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("the Answer button is only a little bigger than the buttons beside it", () => {
	const css = readFileSync(new URL("./static/app.css", import.meta.url), "utf8");
	const px = (rule: string, prop: string) => Number(new RegExp(`${prop}: (\\d+)px`).exec(rule)![1]);
	test("a few px taller and at most 1px larger type than .mini, not the large size of #56; on a touch screen 44px against .mini's 40px", () => {
		const answer = css.match(/\.btn-answer \{([^}]*)\}/)![1]!;
		const mini = css.match(/\.mini \{([^}]*)\}/)![1]!;
		const dh = px(answer, "min-height") - px(mini, "min-height");
		expect(dh).toBeGreaterThan(0);
		expect(dh).toBeLessThanOrEqual(6);
		expect(px(answer, "font-size") - px(mini, "font-size")).toBeLessThanOrEqual(1);
		expect(px(answer, "min-height")).toBeLessThan(48);
		expect(css).toMatch(
			/@media \(pointer: coarse\) \{ \.mini \{ min-height: 40px; \} \.item-actions \.btn-answer, \.item-actions \.btn-ghost \{ min-height: 44px; \} \}/,
		);
	});
	test("a phone gets the same one row: no rule hides the row's Answer or Not now, and no separate, larger answer bar is drawn", () => {
		expect(css).not.toMatch(/\.item-actions \.lead \{ display: none/);
		expect(css).not.toContain("i-mbar");
		const app = readFileSync(new URL("./static/app.js", import.meta.url), "utf8");
		expect(app).not.toContain("i-mbar");
	});
});
