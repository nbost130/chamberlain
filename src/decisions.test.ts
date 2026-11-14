/** `chamberlain decisions repost`: it posts the view only when the page answers and has a view key, and says plainly when it does not. */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { repost } from "./decisions.ts";

describe("decisions repost", () => {
	const before = process.env.T3CODE_CLI_PATH;
	afterAll(() => {
		if (before === undefined) delete process.env.T3CODE_CLI_PATH;
		else process.env.T3CODE_CLI_PATH = before;
	});
	function setup() {
		const conf = mkdtempSync(`${tmpdir()}/chamberlain-decisions-`);
		writeFileSync(`${conf}/decisions-thread`, "decisions-id", { mode: 0o600 });
		const log = `${conf}/argv`;
		writeFileSync(`${conf}/t3`, `#!/bin/sh\necho "$@" >> ${log}\ncat >> ${log}\n`, { mode: 0o700 });
		process.env.T3CODE_CLI_PATH = `${conf}/t3`;
		return { conf, sent: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
	}
	test("page up with a view key: the view is posted to the Decisions thread, with its height and the view key", async () => {
		const { conf, sent } = setup();
		const r = await repost(conf, async () => ({ queueUrl: "http://q.test", capability: "VIEWKEY123" }));
		expect(r).toEqual({ ok: true, line: "the Decisions view was posted again" });
		expect(sent()).toContain("thread send decisions-id -");
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
		const { conf } = setup();
		writeFileSync(`${conf}/t3`, "#!/bin/sh\necho no thread >&2\nexit 3\n", { mode: 0o700 });
		const r = await repost(conf, async () => ({ queueUrl: "http://q.test", capability: "VIEWKEY123" }));
		expect(r).toEqual({ ok: false, line: "the post failed: no thread" });
	});
});
