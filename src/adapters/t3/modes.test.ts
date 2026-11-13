/** The T3 adapter reads its tokens under the same exact-0600 rule as the core (audit finding M4; see src/core/modes.test.ts). */
import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { t3TitleSetter } from "./title.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

test("a token file that is not exactly 0600 is not used, whatever its other bits (a 0700 token used to be accepted)", async () => {
	const conf = mkdtempSync(`${tmpdir()}/chamberlain-t3modes-`);
	dirs.push(conf);
	writeFileSync(`${conf}/operate-token`, "tok");
	for (const mode of [0o700, 0o500, 0o400, 0o640]) {
		chmodSync(`${conf}/operate-token`, mode);
		expect([mode, await t3TitleSetter(conf, "http://127.0.0.1:9", "operate-token", "t1")("Decisions")]).toEqual([mode, "failed"]);
	}
	// At 0600 the token IS read and used: the setter goes on to connect, which fails here because nothing listens. The refusals above are about the mode.
	chmodSync(`${conf}/operate-token`, 0o600);
	await expect(t3TitleSetter(conf, "http://127.0.0.1:9", "operate-token", "t1")("Decisions")).rejects.toThrow();
});
