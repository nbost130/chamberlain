/**
 * Re-posting the pinned Decisions view (`chamberlain decisions repost`) and the height every Decisions shell carries: one shell, one send door,
 * the view key only, so a re-post is never a hand-written html that lost its minimum height.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import type { Question } from "../../core/items/questions.ts";
import { modelServer } from "../../testing/model-server.ts";
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
	const servers: ReturnType<typeof modelServer>[] = [];
	afterEach(() => {
		for (const s of servers.splice(0)) s.close();
	});
	/** A centrally configured RPC endpoint and a page key that must never be posted. */
	function keyed(withThread = true) {
		const s = modelServer();
		servers.push(s);
		const { conf } = s;
		if (!withThread) writeFileSync(`${conf}/config.json`, JSON.stringify({ ...s.config, threads: {} }));
		writeFileSync(`${conf}/secrets/web-token`, `${PAGE}\n`, { mode: 0o600 });
		return s;
	}
	test("it sends the shell, with its height, to the Decisions thread, and holds the view key and not the page's key", async () => {
		const k = keyed();
		expect((await repostView(k.conf, "http://q.test", VIEW)).ok).toBe(true);
		expect(k.requests.at(-1)?.payload.threadId).toBe("decisions-id");
		expect(k.sent()).toContain(SHELL_ROOT);
		expect(k.sent()).toContain(`&amp;k=${VIEW}"></script>`);
		for (const form of [PAGE, encodeURIComponent(PAGE)]) expect(k.sent()).not.toContain(form);
	});
	test("with the page's key handed in as the view key the re-post is refused and nothing is sent", async () => {
		const k = keyed();
		await expect(repostView(k.conf, "http://q.test", PAGE)).rejects.toThrow("refusing to post the page's key");
		expect(k.sent()).toBe("");
	});
	test("a key the provider echoes back is not returned, and with no Decisions thread it fails loudly", async () => {
		const k = keyed();
		k.state.failSend = true;
		k.state.error = `refused: ${VIEW}`;
		const r = await repostView(k.conf, "http://q.test", VIEW);
		expect(r.ok).toBe(false);
		expect(r.detail).not.toContain(VIEW);
		expect(r).toMatchObject({ reason: "unknown", detail: expect.stringContaining("not sent: unknown") });
		const missing = keyed(false);
		const result = await repostView(missing.conf, "http://q.test", VIEW);
		expect(result.ok).toBe(false);
		expect(result).toMatchObject({ reason: "config", detail: expect.stringContaining("not sent: config") });
		expect(missing.sent()).toBe("");
	});
});
