/**
 * Re-posting the pinned Decisions view (`chamberlain decisions repost`) and the height every Decisions shell carries: one shell, one send door,
 * the view key only, so a re-post is never a hand-written html that lost its minimum height.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Question } from "../../core/questions.ts";
import { decisionsMessage, repostView, viewRepostMessage } from "./post.ts";

const VIEW = "k-test-0123456789abcdefghijklmnopqrstuvwxyz";
const PAGE = "p-page-9876543210zyxwvutsrqponmlkjihgfedcba";
const SHELL_ROOT = '<div id="dq" style="min-height:700px"></div>';
const question: Question = {
	id: "Q-abcd",
	kind: "product",
	title: "Which one?",
	context: "",
	options: [{ label: "A" }, { label: "B" }],
	thread: "t",
	server: "s",
	createdAt: "2026-11-14T10:00:00.000Z",
};

describe("every Decisions shell carries the minimum height", () => {
	test("a question's post and a re-post both render a root with min-height:700px, then the script", () => {
		for (const m of [decisionsMessage(question, "http://q.test", VIEW), viewRepostMessage("http://q.test", VIEW)]) {
			expect(m).toContain(`<body>${SHELL_ROOT}<script src="http://q.test/inline.js?view=decisions`);
			expect(m).toContain('title "Decisions", height 720');
		}
	});
	test("the re-post names no item, carries the view key only, and is one render instruction", () => {
		const m = viewRepostMessage("http://q.test/", VIEW);
		expect(m).toContain(`<script src="http://q.test/inline.js?view=decisions&amp;k=${VIEW}"></script>`);
		expect(m).not.toContain("item=");
		expect(m).toContain("Never show a question card here.");
		expect(m.split("\n").filter((l) => l.includes("html_render ("))).toHaveLength(1);
	});
});

describe("repostView sends through the Decisions thread's door", () => {
	const before = process.env.T3CODE_CLI_PATH;
	afterAll(() => {
		if (before === undefined) delete process.env.T3CODE_CLI_PATH;
		else process.env.T3CODE_CLI_PATH = before;
	});
	/** A config directory whose secrets/web-token holds PAGE, with a fake T3 CLI that records everything it is sent. */
	function keyed(withThread = true) {
		const conf = mkdtempSync(`${tmpdir()}/chamberlain-repost-`);
		if (withThread) writeFileSync(`${conf}/decisions-thread`, "decisions-id", { mode: 0o600 });
		mkdirSync(`${conf}/secrets`, { mode: 0o700 });
		writeFileSync(`${conf}/secrets/web-token`, `${PAGE}\n`, { mode: 0o600 });
		const log = `${conf}/argv`;
		writeFileSync(`${conf}/t3`, `#!/bin/sh\necho "$@" >> ${log}\ncat >> ${log}\n`, { mode: 0o700 });
		process.env.T3CODE_CLI_PATH = `${conf}/t3`;
		return { conf, sent: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
	}
	test("it sends the shell, with its height, to the Decisions thread, and holds the view key and not the page's key", () => {
		const k = keyed();
		expect(repostView(k.conf, "http://q.test", VIEW).ok).toBe(true);
		expect(k.sent()).toContain("thread send decisions-id -");
		expect(k.sent()).toContain(SHELL_ROOT);
		expect(k.sent()).toContain(`&amp;k=${VIEW}"></script>`);
		for (const form of [PAGE, encodeURIComponent(PAGE)]) expect(k.sent()).not.toContain(form);
	});
	test("with the page's key handed in as the view key the re-post is refused and nothing is sent", () => {
		const k = keyed();
		expect(() => repostView(k.conf, "http://q.test", PAGE)).toThrow("refusing to post the page's key");
		expect(k.sent()).toBe("");
	});
	test("a key the CLI echoes back is not returned, and with no Decisions thread it fails loudly", () => {
		const k = keyed();
		writeFileSync(`${k.conf}/t3`, `#!/bin/sh\necho "sent: ${VIEW}"\ncat > /dev/null\n`, { mode: 0o700 });
		const r = repostView(k.conf, "http://q.test", VIEW);
		expect(r.detail).not.toContain(VIEW);
		expect(r.detail).toContain("[token]");
		expect(() => repostView(keyed(false).conf, "http://q.test", VIEW)).toThrow("Decisions thread is not set");
	});
});
