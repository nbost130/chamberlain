import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseArgs } from "./ruling.ts";

describe("ruling.ts arguments", () => {
	test("the two texts, with no flags", () => {
		expect(parseArgs(["their words", "what it decides"])).toEqual({
			chat: false,
			opts: {},
			words: "their words",
			decides: "what it decides",
		});
	});
	test("--stated-in-chat, --expires, --until and --supersedes before the words", () => {
		const a = parseArgs([
			"--stated-in-chat",
			"--expires",
			"2026-12-01",
			"--until",
			"the V2 launch",
			"--supersedes",
			"R32,R16",
			"w",
			"d",
		]);
		expect(a).toEqual({
			chat: true,
			opts: { expires: "2026-12-01", until: "the V2 launch", supersedes: ["R32", "R16"] },
			words: "w",
			decides: "d",
		});
	});
	test("a flag without its value is an error", () => {
		expect(() => parseArgs(["--expires"])).toThrow("--expires needs a value");
		expect(() => parseArgs(["w", "d", "--supersedes"])).toThrow("--supersedes needs a value");
	});
	test("a mistyped flag is an error, but words that start with -- and have spaces, or come after --, are words", () => {
		expect(() => parseArgs(["--expire", "2026-12-01", "w", "d"])).toThrow(
			'unknown flag --expire (put their words after "--"',
		);
		expect(parseArgs(["--never do that", "d"]).words).toBe("--never do that");
		expect(parseArgs(["--", "--expire", "d"])).toMatchObject({ words: "--expire", decides: "d" });
		expect(parseArgs(["--expires", "2026-12-01", "--", "--stated-in-chat", "d"])).toMatchObject({
			chat: false,
			opts: { expires: "2026-12-01" },
			words: "--stated-in-chat",
			decides: "d",
		});
	});
	test("a missing text comes back undefined, for the usage message", () => {
		expect(parseArgs(["only words"])).toMatchObject({ words: "only words", decides: undefined });
	});
});

describe("ruling.ts as a command", () => {
	/** ruling.ts as a real process on a scratch state directory. */
	const scratch = () => {
		const dir = mkdtempSync(`${tmpdir()}/chamberlain-ruling-`);
		return (...args: string[]) => {
			const {
				XDG_STATE_HOME: _s,
				XDG_CACHE_HOME: _c,
				XDG_CONFIG_HOME: _f,
				CHAMBERLAIN_STATE: _a,
				...rest
			} = process.env;
			const r = spawnSync(process.execPath, [new URL("./ruling.ts", import.meta.url).pathname, ...args], {
				env: { ...rest, HOME: dir, CHAMBERLAIN_STATE: `${dir}/state`, CHAMBERLAIN_CONF: `${dir}/conf` },
				encoding: "utf8",
			});
			return { out: r.stdout.trimEnd(), err: r.stderr.trimEnd(), code: r.status };
		};
	};
	const USAGE =
		'usage: ruling.ts [--stated-in-chat] [--expires <ISO>] [--until "<event>"] [--supersedes R32,R16] [--] "<their exact words>" "<what it decides>" | list';

	test("a proposal is recorded, and the same words again add nothing", () => {
		const run = scratch();
		expect(run("list")).toMatchObject({ out: "", code: 0 });
		expect(run("w1", "d1")).toMatchObject({
			out: "proposed R1: not in force until the operator confirms it on the rulings page",
			code: 0,
		});
		expect(run("w1", "d1").out).toBe("already recorded as R1 (proposed); nothing new added");
		expect(run("list").out).toBe('R1\tproposed\tcard\tunconfirmed\t"w1" -> d1');
	});

	test("a proposal that supersedes names what it retires when the principal confirms", () => {
		const run = scratch();
		run("--stated-in-chat", "w1", "d1");
		run("--stated-in-chat", "w2", "d2");
		expect(run("--supersedes", "R1,R2", "w3", "d3").out).toBe(
			"proposed R3: not in force until the operator confirms it on the rulings page; it retires R1, R2 when they do",
		);
	});

	test("a ruling stated in chat is in force at once and retires what it supersedes", () => {
		const run = scratch();
		expect(run("w1", "d1").code).toBe(0);
		expect(run("--stated-in-chat", "w2", "d2").out).toBe("recorded R2, in force");
		expect(run("--stated-in-chat", "w2", "d2").out).toBe("already recorded as R2 (in-force); nothing new added");
		expect(run("--stated-in-chat", "--supersedes", "R1", "w3", "d3").out).toBe(
			"recorded R3, in force; R1 retired as superseded",
		);
		expect(run("--stated-in-chat", "--supersedes", "R1", "w2", "d2").out).toBe(
			"already recorded as R2 (in-force); it now also supersedes R1, retired as superseded now",
		);
		expect(run("list").out).toBe(
			[
				'R1\tretired\tcard\tunconfirmed\t"w1" -> d1',
				'R2\tin-force\tchat\tconfirmed\t"w2" -> d2',
				'R3\tin-force\tchat\tconfirmed\t"w3" -> d3',
			].join("\n"),
		);
	});

	test("a proposal for words already in force says so, and says why it cannot supersede", () => {
		const run = scratch();
		run("--stated-in-chat", "w2", "d2");
		run("--stated-in-chat", "w3", "d3");
		expect(run("w2", "d2").out).toBe("already recorded as R1 (in force); nothing new added");
		expect(run("--supersedes", "R2", "w2", "d2").out).toBe(
			"already recorded as R1 (in force); nothing new added. It does not supersede R2: a proposal cannot change a ruling in force; the operator retires or replaces it on the rulings page",
		);
	});

	test("a proposal repeated with a new supersedes says when it retires", () => {
		const run = scratch();
		run("--stated-in-chat", "w1", "d1");
		run("w2", "d2");
		expect(run("--supersedes", "R1", "w2", "d2").out).toBe(
			"already recorded as R2 (proposed); it now also supersedes R1, retired when the operator confirms it",
		);
	});

	test("a bad call prints the reason and the usage and exits 2", () => {
		const run = scratch();
		expect(run("--expire", "x")).toMatchObject({
			err: `unknown flag --expire (put their words after "--" if they really start with it)\n${USAGE}`,
			code: 2,
		});
		expect(run("--expires")).toMatchObject({ err: `--expires needs a value\n${USAGE}`, code: 2 });
		expect(run("only words")).toMatchObject({ err: USAGE, code: 2 });
	});

	test("a ruling that cannot be recorded exits 1 with the reason", () => {
		const run = scratch();
		expect(run("--stated-in-chat", "--supersedes", "R99", "w", "d")).toMatchObject({
			err: "supersedes R99: no such ruling",
			code: 1,
		});
	});
});
