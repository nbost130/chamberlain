/** `chamberlain decisions repost`: it posts the view only when the page answers and has a view key, and says plainly when it does not. */
import { afterEach, describe, expect, test } from "bun:test";
import { repost } from "./decisions.ts";
import { modelServer } from "./testing/model-server.ts";

describe("decisions repost", () => {
	const servers: ReturnType<typeof modelServer>[] = [];
	afterEach(() => {
		for (const s of servers.splice(0)) s.close();
	});
	function setup() {
		const s = modelServer();
		servers.push(s);
		return s;
	}
	test("page up with a view key: the view is posted to the Decisions thread, with its height and the view key", async () => {
		const { conf, sent, requests } = setup();
		const r = await repost(conf, async () => ({ queueUrl: "http://q.test", capability: "VIEWKEY123" }));
		expect(r).toEqual({ ok: true, line: "the Decisions view was posted again" });
		expect(requests.find((r) => r.payload.type === "message.dispatch")?.payload.threadId).toBe("decisions-id");
		expect(sent()).toContain('<div id="dq" style="min-height:700px"></div>');
		expect(sent()).toContain("inline.js?view=decisions&amp;k=VIEWKEY123");
	});
	test("page down, or no view key: nothing is posted, not even a notice, and it says why", async () => {
		const { conf, sent } = setup();
		for (const view of [
			{ queueUrl: undefined, capability: undefined },
			{ queueUrl: "http://q.test", capability: undefined },
			{ queueUrl: undefined, capability: "VIEWKEY123" },
		]) {
			const r = await repost(conf, async () => view);
			expect(r.ok).toBe(false);
			expect(r.line).toContain("nothing posted");
		}
		expect(sent()).toBe("");
	});
	test("a failing send is reported, not swallowed", async () => {
		const { conf, state } = setup();
		state.failSend = true;
		const r = await repost(conf, async () => ({ queueUrl: "http://q.test", capability: "VIEWKEY123" }));
		expect(r.ok).toBe(false);
		expect(r.line).toContain("the post failed:");
		expect(r.line).toContain("send failed");
	});
});
