/**
 * The test-only helpers refuse to run in production. `testRelay` builds a relay over a stubbed lock, which in production would be a relay that
 * enforces nothing; src/architecture.test.ts keeps production code from importing src/testing/, and this gate is what holds if one gets in anyway
 * (a computed import the scan cannot read). Both are checked here with a real production-shaped process that imports the helper by an absolute path.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { testRelayLock } from "../testing/lock.ts";
import { testRelay } from "../testing/relay.ts";
import { memStore } from "../testing/store.ts";
import { holdTestRelayLock } from "./singleton.ts";
import { inTestEnv, requireTestEnv, TEST_ONLY_FLAG } from "./test-env.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const wake = { ready: () => true, send: async () => ({ ok: true }) };

/** Runs `code` in a fresh process with exactly `env` (no NODE_ENV or BUN_ENV from this test run) and returns what it printed. */
async function inFreshProcess(code: string, env: Record<string, string>): Promise<string> {
	const dir = mkdtempSync(`${tmpdir()}/chamberlain-env-`);
	dirs.push(dir);
	const p = Bun.spawn([process.execPath, "-e", code], {
		cwd: dir,
		env: { PATH: process.env.PATH ?? "", HOME: dir, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return `${out}${err}`.trim();
}
const helper = (name: string) => JSON.stringify(new URL(`../testing/${name}`, import.meta.url).pathname);

describe("the test-only helpers need a test environment", () => {
	test("NODE_ENV or BUN_ENV set to test, or the explicit flag, is a test environment; nothing else is", () => {
		expect(inTestEnv({ NODE_ENV: "test" })).toBe(true);
		expect(inTestEnv({ BUN_ENV: "test" })).toBe(true);
		expect(inTestEnv({ [TEST_ONLY_FLAG]: "1" })).toBe(true);
		expect(inTestEnv({})).toBe(false);
		expect(inTestEnv({ NODE_ENV: "production" })).toBe(false);
		expect(inTestEnv({ NODE_ENV: "development", BUN_ENV: "production" })).toBe(false);
		expect(inTestEnv({ [TEST_ONLY_FLAG]: "0" })).toBe(false);
		expect(() => requireTestEnv("testRelay", { NODE_ENV: "production" })).toThrow("test-only");
		expect(() => requireTestEnv("testRelay", { NODE_ENV: "test" })).not.toThrow();
	});

	test("under bun test, testRelay and the stub lock work", () => {
		expect(inTestEnv()).toBe(true);
		const store = memStore();
		expect(() => testRelay(store, wake)).not.toThrow();
		expect(testRelayLock(store).held()).toBe(true);
	});

	test("outside a test, testRelay and the stub lock refuse in this process", () => {
		const keep = { NODE_ENV: process.env.NODE_ENV, BUN_ENV: process.env.BUN_ENV, flag: process.env[TEST_ONLY_FLAG] };
		try {
			process.env.NODE_ENV = "production";
			delete process.env.BUN_ENV;
			delete process.env[TEST_ONLY_FLAG];
			const store = memStore();
			expect(() => testRelay(store, wake)).toThrow("test-only");
			expect(() => testRelayLock(store)).toThrow("test-only");
			expect(() => holdTestRelayLock(":memory:")).toThrow("test-only");
			process.env[TEST_ONLY_FLAG] = "1";
			expect(() => testRelay(store, wake)).not.toThrow();
		} finally {
			for (const [k, v] of [
				["NODE_ENV", keep.NODE_ENV],
				["BUN_ENV", keep.BUN_ENV],
				[TEST_ONLY_FLAG, keep.flag],
			] as const) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});

	test("a production process that smuggles in the helper gets no relay (a computed import, as the scanner cannot see)", async () => {
		const smuggled = `
			const where = ${helper("relay.ts")}.replace("relay.ts", "") + "re" + "lay.ts";
			const { testRelay } = await import(where);
			const { openStore } = await import(${JSON.stringify(new URL("./sqlite-store.ts", import.meta.url).pathname)});
			const store = openStore(":memory:");
			try { testRelay(store, { ready: () => true, send: async () => ({ ok: true }) }); console.log("RELAY BUILT"); } catch (e) { console.log("refused: " + e.message.slice(0, 60)); }
		`;
		expect(await inFreshProcess(smuggled, { NODE_ENV: "production" })).toStartWith("refused: testRelay is test-only");
		expect(await inFreshProcess(smuggled, {})).toStartWith("refused: testRelay is test-only");
		// The same process with the explicit flag builds one: the gate, not something else, is what stopped it.
		expect(await inFreshProcess(smuggled, { [TEST_ONLY_FLAG]: "1" })).toBe("RELAY BUILT");
		expect(await inFreshProcess(smuggled, { NODE_ENV: "test" })).toBe("RELAY BUILT");
	});
});
