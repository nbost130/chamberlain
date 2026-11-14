import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	createJudge,
	defaultJudgeConfig,
	type JudgeRunner,
	judgeOff,
	parseJudgeConfig,
	readJudgeConfig,
	scrubForJudge,
} from "./judge.ts";

const verdicts = ["retry_later", "do_not_retry", "ask_principal"] as const;
const runnerOf =
	(stdout: string, code = 0, calls: string[][] = []): JudgeRunner =>
	async (argv) => {
		calls.push(argv);
		return { code, stdout, stderr: code ? "boom" : "" };
	};

/** A judge.json that names a backend for the trigger, as an operator writes one. */
const configured = () =>
	parseJudgeConfig(
		JSON.stringify({
			triggers: { "stalled-recovery": { backend: "small" } },
			backends: { small: { command: ["/x/judge", "--level", "low"] } },
		}),
	).config;

describe("judge configuration", () => {
	test("there is no default backend: without judge.json nothing is judged, and judgeOff says why", () => {
		expect(defaultJudgeConfig()).toEqual({ triggers: {}, backends: {} });
		expect(readJudgeConfig(mkdtempSync(`${tmpdir()}/judge-none-`))).toEqual({ config: { triggers: {}, backends: {} } });
		expect(judgeOff(defaultJudgeConfig(), "stalled-recovery")).toContain(
			'names no backend for the "stalled-recovery" trigger',
		);
		expect(judgeOff(configured(), "stalled-recovery")).toBeUndefined();
	});
	test("no private tool is named anywhere in the judge's source", () => {
		const src = readFileSync(new URL("./judge.ts", import.meta.url), "utf8");
		expect(src).not.toMatch(/Inference\.ts|\.claude\/|homedir/);
	});
	test("a file names its own backends and which one judges a trigger", () => {
		const { config, error } = parseJudgeConfig(
			JSON.stringify({
				triggers: { "stalled-recovery": { backend: "other" } },
				backends: { small: { command: ["/bin/a"] }, other: { command: ["/bin/other-judge"] } },
			}),
		);
		expect(error).toBeUndefined();
		expect(config.triggers["stalled-recovery"]!.backend).toBe("other");
		expect(config.backends.other!.command).toEqual(["/bin/other-judge"]);
		expect(config.backends.small).toBeDefined();
	});
	test("a bad file reports why and judges nothing", () => {
		for (const bad of [
			'{"triggers":{"nope":{"backend":"a"}},"backends":{"a":{"command":["x"]}}}',
			'{"triggers":{"stalled-recovery":{"backend":"gpt"}}}',
			'{"backends":{"a":{"command":[]}}}',
			'{"backends":{"a b":{"command":["x"]}}}',
			"not json",
		]) {
			const r = parseJudgeConfig(bad);
			expect(r.error).toMatch(/judge\.json/);
			expect(r.config).toEqual(defaultJudgeConfig());
		}
	});
});

describe("judge configuration errors", () => {
	test("each bad file names the first thing wrong with it", () => {
		const errorOf = (raw: unknown) => parseJudgeConfig(JSON.stringify(raw)).error;
		const ok = { a: { command: ["x"] } };
		expect(errorOf({ backends: { "a b": { command: ["x"] } } })).toBe(
			'judge.json: backend name "a b" must be letters, digits, ".", "_" or "-"',
		);
		expect(errorOf({ backends: { a: { command: [] } } })).toBe(
			'judge.json: backend "a": command must be a non-empty list of strings',
		);
		expect(errorOf({ backends: { a: { command: ["x", ""] } } })).toBe(
			'judge.json: backend "a": command must be a non-empty list of strings',
		);
		expect(errorOf({ backends: { a: null } })).toBe(
			'judge.json: backend "a": command must be a non-empty list of strings',
		);
		expect(errorOf({ backends: ok, triggers: { nope: { backend: "a" } } })).toBe('judge.json: unknown trigger "nope"');
		expect(errorOf({ backends: ok, triggers: { "stalled-recovery": {} } })).toBe(
			'judge.json: trigger "stalled-recovery": backend must name a backend',
		);
		expect(errorOf({ backends: ok, triggers: { "stalled-recovery": { backend: "a b" } } })).toBe(
			'judge.json: trigger "stalled-recovery": backend must name a backend',
		);
		expect(errorOf({ triggers: { "stalled-recovery": { backend: "gpt" } } })).toBe(
			'judge.json: trigger "stalled-recovery": backend "gpt" is not in "backends"',
		);
	});
	test("a good file adds its backends, then points its triggers at them", () => {
		const { config, error } = parseJudgeConfig(
			JSON.stringify({
				backends: { a: { command: ["x", "-y"] } },
				triggers: { "stalled-recovery": { backend: "a" } },
			}),
		);
		expect(error).toBeUndefined();
		expect(config.backends.a).toEqual({ command: ["x", "-y"] });
		expect(config.triggers["stalled-recovery"]).toEqual({ backend: "a" });
	});
});

describe("the one judge", () => {
	test("calls the trigger's backend with the system and user prompts as the last two arguments, and returns its verdict", async () => {
		const calls: string[][] = [];
		const judge = createJudge({
			config: () => configured(),
			run: runnerOf('{"verdict":"do_not_retry","reason":"persistent"}', 0, calls),
		});
		const a = await judge("stalled-recovery", { system: "SYS", user: "USER", verdicts });
		expect(a).toEqual({ ok: true, backend: "small", verdict: "do_not_retry", reason: "persistent" });
		expect(calls[0]!.slice(-2)).toEqual(["SYS", "USER"]);
		expect(calls[0]).toContain("--level");
	});
	test("a trigger whose backend has no command fails cleanly, naming what is missing", async () => {
		const cfg = { triggers: { "stalled-recovery": { backend: "other" } }, backends: {} };
		const a = await createJudge({ config: () => cfg, run: runnerOf("{}") })("stalled-recovery", {
			system: "",
			user: "",
			verdicts,
		});
		expect(a).toMatchObject({ ok: false, backend: "other" });
		expect((a as { error: string }).error).toMatch(/backends\.other\.command/);
	});
	test("no judge.json: a clean failure that names why, never a throw, and nothing is run", async () => {
		const calls: string[][] = [];
		const a = await createJudge({ config: () => defaultJudgeConfig(), run: runnerOf("{}", 0, calls) })(
			"stalled-recovery",
			{ system: "", user: "", verdicts },
		);
		expect(a).toMatchObject({ ok: false, backend: "none" });
		expect(calls).toEqual([]);
	});
	test("a verdict outside the trigger's list, bad JSON, a nonzero exit and a thrown runner are all failures", async () => {
		const cases: JudgeRunner[] = [
			runnerOf('{"verdict":"merge_it"}'),
			runnerOf("sorry, no"),
			runnerOf("", 1),
			async () => {
				throw Error("spawn failed");
			},
		];
		for (const run of cases)
			expect(
				(await createJudge({ config: () => configured(), run })("stalled-recovery", { system: "", user: "", verdicts }))
					.ok,
			).toBe(false);
	});
	test("it reads the last JSON line, so a backend that logs first still answers", async () => {
		const a = await createJudge({
			config: () => configured(),
			run: runnerOf('[model] vendor=anthropic\n{"verdict":"retry_later","reason":"r"}\n'),
		})("stalled-recovery", { system: "", user: "", verdicts });
		expect(a).toMatchObject({ ok: true, verdict: "retry_later" });
	});
});

describe("scrubForJudge", () => {
	test("home directories, emails, long tokens and query strings never reach a judge", () => {
		const s = scrubForJudge(
			`failed in /home/someone/dev/Secret for a@b.co at https://x.test/p?token=xxxxxxxxxxxxxxxxxxxxxxxxxx with key ${"key"}_${"x".repeat(30)}`,
		);
		expect(s).not.toMatch(/someone|a@b\.co|token=|key_x{10}/);
	});
	test("it clips", () => expect(scrubForJudge("word ".repeat(100), 50)).toHaveLength(50));
});

describe("there is one path to a model", () => {
	const SRC = new URL("..", import.meta.url).pathname;
	const walk = (dir: string): string[] =>
		readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
			e.isDirectory()
				? walk(join(dir, e.name))
				: e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")
					? [join(dir, e.name)]
					: [],
		);
	test("no source file names an inference tool of its own: the judge runs only the command judge.json names", () => {
		const hits = walk(SRC)
			.filter((f) => /Inference\.ts|\/TOOLS\//.test(readFileSync(f, "utf8")))
			.map((f) => relative(SRC, f));
		expect(hits).toEqual([]);
	});
});
