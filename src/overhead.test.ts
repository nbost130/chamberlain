/** `chamberlain overhead`, run as a real process against a throwaway config and state directory. */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { usage } from "./cli.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function overhead(args: string[], config: Record<string, unknown> = {}) {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-overhead-`);
	dirs.push(root);
	mkdirSync(`${root}/conf`, { mode: 0o700 });
	mkdirSync(`${root}/state`, { mode: 0o700 });
	writeFileSync(`${root}/conf/config.json`, JSON.stringify(config), { mode: 0o600 });
	const p = Bun.spawnSync([process.execPath, `${import.meta.dir}/overhead.ts`, ...args], {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: root,
			CHAMBERLAIN_CONF: `${root}/conf`,
			CHAMBERLAIN_STATE: `${root}/state`,
		},
	});
	return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("chamberlain overhead", () => {
	test("is listed in the command help", () => {
		expect(usage()).toContain("overhead");
	});

	test("with nothing configured prints the numbers it can, and says what is not configured, without calling out", () => {
		const r = overhead([]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("Overhead, rolling 24 h");
		expect(r.out).toContain("cost per merged PR   24 h not configured");
		expect(r.out).toContain("NOT CONFIGURED: merged PRs: set overhead.github.owners or overhead.github.repos");
		expect(r.out).toContain("NOT CONFIGURED: fleet spend");
		expect(r.out).toContain("UNAVAILABLE: Steward spend: no models.steward");
		expect(r.out).toContain("No investigation held.");
	});

	test("--json prints the report, with the status of each outside read", () => {
		const r = overhead(["--json"]);
		expect(r.code).toBe(0);
		const j = JSON.parse(r.out);
		expect(j).toMatchObject({ prStatus: "not-configured", fleetStatus: "not-configured", windowMs: 86_400_000 });
		expect(j.crossings).toEqual([]);
	});

	test("an invalid overhead section is refused with the key named, and nothing is measured", () => {
		const r = overhead([], { overhead: { triggers: { noopRate: { threshold: -1 } } } });
		expect(r.code).toBe(1);
		expect(r.err).toContain("threshold must be a number above 0 and up to 1");
	});

	test("lists no investigations, and refuses to close one that does not exist", () => {
		expect(overhead(["investigations"]).out).toContain("no investigations");
		const r = overhead(["close", "OV-nope"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain("no investigation OV-nope");
	});

	test("an unknown argument is a usage error", () => {
		const r = overhead(["--days", "3"]);
		expect(r.code).toBe(1);
		expect(r.err).toContain("usage: overhead");
	});
});
