import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { getValue, main, planLines, showLines } from "./config-cmd.ts";
import type { Plan } from "./config-plan.ts";
import { resetLayout } from "./layout-legacy.ts";

const dirs: string[] = [];
const fresh = () => {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-confcmd-`);
	dirs.push(root);
	const conf = `${root}/conf`;
	mkdirSync(conf, { mode: 0o700 });
	return conf;
};
afterEach(() => {
	resetLayout();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const NONE = {} as Record<string, string | undefined>;
const doc = (conf: string, body: unknown) =>
	writeFileSync(`${conf}/config.json`, JSON.stringify(body), { mode: 0o600 });

const emptyPlan = (): Plan => ({
	config: {},
	writeConfig: false,
	added: [],
	differs: [],
	secrets: [],
	renames: [],
	problems: [],
	notes: [],
	stays: [],
	leftovers: [],
	reappeared: [],
});

describe("planLines", () => {
	test("says there is nothing to do when the plan is empty", () => {
		expect(planLines(emptyPlan(), { dryRun: false })).toEqual([
			"nothing to do: config.json and secrets/ already hold everything the old files do",
		]);
	});

	test("lists every part of a plan, in order, as would-do lines on a dry run", () => {
		const plan: Plan = {
			...emptyPlan(),
			writeConfig: true,
			added: [{ key: "principal", from: "principal.txt" }],
			differs: [{ key: "web.port", from: "web-port" }],
			secrets: [
				{ name: "a-token", action: "move" },
				{ name: "b-token", action: "present" },
				{ name: "c-token", action: "present", why: "same bytes" },
				{ name: "d-token", action: "skip", why: "not 0600" },
				{ name: "e-token", action: "differs", why: "two values" },
			],
			renames: ["principal.txt"],
			problems: ["judge.json: not private"],
			notes: ["a note"],
			stays: ["decision-rights.md"],
			leftovers: ["judge.json"],
			reappeared: ["laptop-token"],
		};
		expect(planLines(plan, { dryRun: true, skipped: "another run holds the lock" })).toEqual([
			"not migrated: another run holds the lock",
			"config.json: would write 1 key",
			"  + principal   (from principal.txt)",
			"secrets/a-token: would move here (mode 0600, date kept)",
			"secrets/b-token: already there",
			"secrets/c-token: already there; same bytes",
			"secrets/d-token: skipped: not 0600",
			"secrets/e-token: differs: two values",
			"principal.txt: would be set aside as principal.txt.migrated",
			"differs: web.port in web-port is not what config.json holds; config.json wins",
			"note: a note",
			"PROBLEM: judge.json: not private",
			"stay as files: decision-rights.md",
			"REAPPEARED  laptop-token: written at its old place after the migration, and NEVER read. The secret lives in secrets/laptop-token. Mint new secrets into secrets/<name>, not at the old path.",
			"not migrated, and still read from their old place: judge.json. Fix what is reported above and run `chamberlain config migrate` again.",
		]);
	});

	test("a real run says wrote and moved, pluralizes the key count, and ends by saying the files were moved", () => {
		const plan: Plan = {
			...emptyPlan(),
			writeConfig: true,
			added: [
				{ key: "a", from: "a-file" },
				{ key: "b", from: "b-file" },
			],
			secrets: [{ name: "a-token", action: "move" }],
			renames: ["a-file"],
		};
		expect(planLines(plan, { dryRun: false })).toEqual([
			"config.json: wrote 2 keys",
			"  + a   (from a-file)",
			"  + b   (from b-file)",
			"secrets/a-token: moved here (mode 0600, date kept)",
			"a-file: set aside as a-file.migrated",
			"the old files were MOVED, not copied. `chamberlain config revert` puts them back.",
		]);
	});
});

describe("getValue", () => {
	test("refuses a usage error, a secret name and a secrets/ path, and says so", () => {
		const conf = fresh();
		const usage = { ok: false as const, error: "usage: chamberlain config get <key>, for example threads.steward" };
		expect(getValue("", conf, NONE)).toEqual(usage);
		expect(getValue("web..port", conf, NONE)).toEqual(usage);
		expect(getValue("secrets.x", conf, NONE)).toEqual({
			ok: false,
			error: "secrets.x: that names a secret. config get never prints one; secrets are files in secrets/",
		});
		expect(getValue("wake-url", conf, NONE)).toEqual({
			ok: false,
			error: "wake-url: that names a secret. config get never prints one; secrets are files in secrets/",
		});
	});

	test("names the threads when one is unknown", () => {
		const r = getValue("threads.nobody", fresh(), NONE);
		expect(r).toEqual({ ok: false, error: expect.stringMatching(/^no such thread: nobody \(steward, /) });
	});

	test("walks a path into a section: an object key, a list index, and anything that is not there is not set", () => {
		const conf = fresh();
		doc(conf, { web: { port: 3790, nested: { deep: true } }, servers: [{ name: "main" }, { name: "laptop" }] });
		expect(getValue("web.port", conf, NONE)).toEqual({ ok: true, text: "3790" });
		expect(getValue("web.nested", conf, NONE)).toEqual({ ok: true, text: '{"deep":true}' });
		expect(getValue("servers.1.name", conf, NONE)).toEqual({ ok: true, text: "laptop" });
		expect(getValue("servers.first", conf, NONE)).toEqual({ ok: false, error: "servers.first: not set" });
		expect(getValue("servers.5", conf, NONE)).toEqual({ ok: false, error: "servers.5: not set" });
		expect(getValue("web.nothing", conf, NONE)).toEqual({ ok: false, error: "web.nothing: not set" });
		expect(getValue("web.port.more", conf, NONE)).toEqual({ ok: false, error: "web.port.more: not set" });
		expect(getValue("nothing.at.all", conf, NONE)).toEqual({ ok: false, error: "nothing.at.all: not set" });
	});
});

describe("showLines", () => {
	test("on an empty directory: absent file, no thread in the file, no secrets", () => {
		const conf = fresh();
		const lines = showLines(conf, NONE);
		expect(lines.slice(0, 4)).toEqual([
			`config directory  ${conf}`,
			"config.json  absent (the old files, if any, are read as a fallback)",
			"",
			"settings (environment, then config.json, then an old file, then the default):",
		]);
		expect(lines).toContain("sections:");
		expect(lines.some((l) => l.startsWith("  steward") && l.includes("(not in config.json;"))).toBe(true);
		expect(lines.at(-1)).toBe("  (none)");
	});

	test("describes each kind of section and each thread, and lists a secret by where it is read from", () => {
		const conf = fresh();
		doc(conf, {
			servers: [{ name: "main" }, "oops", { name: "laptop" }],
			sweep: { everyMs: 1 },
			judge: {},
			alertDesk: { x: 1 },
			threads: { steward: "T-1", decisions: null },
		});
		mkdirSync(`${conf}/secrets`, { mode: 0o700 });
		writeFileSync(`${conf}/secrets/good-token`, "fake\n", { mode: 0o600 });
		writeFileSync(`${conf}/secrets/loose-token`, "fake\n", { mode: 0o644 });
		writeFileSync(`${conf}/secrets/half.tmp-123`, "fake\n", { mode: 0o600 });
		chmodSync(`${conf}/secrets/loose-token`, 0o644);
		const out = showLines(conf, { CHAMBERLAIN_PRINCIPAL: "Env" }).join("\n");
		expect(out).toContain("config.json  present");
		expect(out).toContain('  principal              "Env"   (env CHAMBERLAIN_PRINCIPAL)');
		expect(out).toContain("  servers                3 entries (main, ?, laptop)   (config.json)");
		expect(out).toContain("  sweep                  keys: everyMs   (config.json)");
		expect(out).toContain("  judge                  keys:    (config.json)");
		expect(out).toContain('  steward                "T-1"');
		expect(out).toContain("  decisions              none");
		expect(out).toContain("  good-token                   secrets/");
		expect(out).toContain("  loose-token                  secrets/   MODE NOT 0600: refused");
		expect(out).not.toContain("half.tmp-123");
		expect(out).not.toContain("fake");
	});

	test("a one-entry list says entry, not entries", () => {
		const conf = fresh();
		doc(conf, { servers: [{ name: "main" }] });
		expect(showLines(conf, NONE).join("\n")).toContain("  servers                1 entry (main)   (config.json)");
	});
});

describe("main", () => {
	const run = (argv: string[]) => {
		const out: string[] = [];
		const err: string[] = [];
		const log = spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
		const error = spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
		const before = process.exitCode;
		process.exitCode = 0;
		let thrown: unknown;
		try {
			main(argv);
		} catch (e) {
			thrown = e;
		}
		const code = process.exitCode;
		process.exitCode = before ?? 0;
		log.mockRestore();
		error.mockRestore();
		return { out, err, code, thrown };
	};

	test("no subcommand or an unknown one prints the usage and exits 2", () => {
		for (const argv of [[], ["bogus"]]) {
			const r = run(argv);
			expect(r.err).toEqual(["usage: chamberlain config migrate [--dry-run] | revert [--dry-run] | show | get <key>"]);
			expect(r.code).toBe(2);
		}
	});

	test("migrate and revert refuse an unknown argument by throwing the usage", () => {
		expect(run(["migrate", "--now"]).thrown).toEqual(
			Error("usage: chamberlain config migrate [--dry-run] (unknown: --now)"),
		);
		expect(run(["revert", "--now", "x"]).thrown).toEqual(
			Error("usage: chamberlain config revert [--dry-run] (unknown: --now x)"),
		);
	});

	test("migrate --dry-run on an empty directory says it would write an empty config.json and exits clean", () => {
		const r = run(["migrate", "--dry-run"]);
		expect(r.out).toEqual(["config.json: would write 0 keys"]);
		expect(r.code).toBe(0);
	});

	test("revert --dry-run prints what the revert reports", () => {
		const r = run(["revert", "--dry-run"]);
		expect(r.thrown).toBeUndefined();
		expect(r.err).toEqual([]);
		expect(r.out.every((l) => typeof l === "string")).toBe(true);
	});

	test("show prints the config lines", () => {
		const r = run(["show"]);
		expect(r.out[0]).toMatch(/^config directory {2}/);
		expect(r.code).toBe(0);
	});

	test("get needs exactly one key (exit 2), prints a value bare, and exits 1 on one that is not set", () => {
		expect(run(["get"])).toMatchObject({
			err: ["usage: chamberlain config get <key>   (for example threads.steward, web.port, stallMs)"],
			code: 2,
		});
		expect(run(["get", "a", "b"]).code).toBe(2);
		expect(run(["get", "nothing.at.all"])).toMatchObject({ err: ["nothing.at.all: not set"], code: 1, out: [] });
	});
});
