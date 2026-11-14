/**
 * The Decisions view's height does not depend on the shell that loads it: inline.js sets the minimum height on its own root and on the body when it
 * mounts. (A re-post written by hand once lacked the shell's style and the frame showed small. The shell's own height: src/adapters/t3/post.repost.test.ts.)
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { run, settle } from "../testing/inline-dom.ts";
import { item } from "../testing/web-inline-view-fixtures.ts";

test("the mounted Decisions view carries min-height:700px on its root and on the body, though the shell gave its root no style", async () => {
	const dq = run(() => ({ items: [item("x")] }), { src: "http://queue.test/inline.js?view=decisions&k=KEY" });
	// run() builds a root with no style at all, as a shell written by hand might
	expect(dq.style.minHeight).toBe("700px");
	expect(dq.parent!.tag).toBe("body");
	expect(dq.parent!.style.minHeight).toBe("700px");
	await settle();
	expect(dq.style.minHeight).toBe("700px"); // a refresh does not undo it
});

test("a view with no root of its own in the shell makes one, and it has the height too", async () => {
	const dq = run(() => ({ items: [] }), { src: "http://queue.test/inline.js?view=decisions&k=KEY", noRoot: true });
	await settle();
	expect(dq.style.minHeight).toBe("700px");
});

test("a single question's view (?item=, with no view=decisions) is not stretched", async () => {
	const dq = run(() => ({ items: [item("x")] }), { src: "http://queue.test/inline.js?item=Q-ctx1&k=KEY" });
	await settle();
	expect(dq.style.minHeight).toBeUndefined();
	expect(dq.parent!.style.minHeight).toBeUndefined();
});

test("every button in a card's row is a pill: the option buttons, Snooze, Dismiss, Direction and the thread link share one rule", () => {
	const css = readFileSync(new URL("./static/inline.js", import.meta.url), "utf8");
	const rule = css.match(/\.dq-pill,\.dq-btn,[^{]*\{([^}]*)\}/)![1]!;
	expect(rule).toContain("border-radius:999px");
	expect(rule).toContain("min-height:40px");
	expect(rule).toMatch(/border:1px solid color-mix/);
	expect(css).toMatch(/\.dq-btn\.rec,[^{]*\{background:var\(--primary\)/); // the recommended option stays filled
	expect(css).toContain('el("a", "dq-pill"'); // the thread link is a pill too
});
