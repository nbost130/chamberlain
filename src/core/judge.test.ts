import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createJudge, defaultJudgeConfig, parseJudgeConfig, scrubForJudge, type JudgeRunner } from "./judge.ts";

const INF = "/x/Inference.ts";
const verdicts = ["retry_later", "do_not_retry", "ask_principal"] as const;
const runnerOf = (stdout: string, code = 0, calls: string[][] = []): JudgeRunner => async (argv) => { calls.push(argv); return { code, stdout, stderr: code ? "boom" : "" }; };

describe("judge configuration", () => {
	test("the stalled-recovery trigger defaults to Haiku, through the inference tool at the cheap level, with no vendor fallback", () => {
		const c = defaultJudgeConfig(INF);
		expect(c.triggers["stalled-recovery"]).toEqual({ backend: "haiku" });
		expect(c.backends.haiku!.command).toEqual([process.execPath, INF, "--level", "low", "--json", "--vendor", "anthropic", "--no-fallback"]);
	});
	test("the default trigger is never Custom", () => expect(defaultJudgeConfig(INF).triggers["stalled-recovery"]!.backend).not.toBe("custom"));
	test("a file can move a trigger to Custom and name its command", () => {
		const { config, error } = parseJudgeConfig(JSON.stringify({ triggers: { "stalled-recovery": { backend: "custom" } }, backends: { custom: { command: ["/bin/custom-judge"] } } }), defaultJudgeConfig(INF));
		expect(error).toBeUndefined();
		expect(config.triggers["stalled-recovery"]!.backend).toBe("custom");
		expect(config.backends.custom!.command).toEqual(["/bin/custom-judge"]);
		expect(config.backends.haiku).toBeDefined();
	});
	test("a bad file reports why and leaves the defaults", () => {
		for (const bad of ['{"triggers":{"nope":{"backend":"haiku"}}}', '{"triggers":{"stalled-recovery":{"backend":"gpt"}}}', '{"backends":{"haiku":{"command":[]}}}', "not json"]) {
			const r = parseJudgeConfig(bad, defaultJudgeConfig(INF));
			expect(r.error).toMatch(/judge\.json/);
			expect(r.config).toEqual(defaultJudgeConfig(INF));
		}
	});
});

describe("the one judge", () => {
	test("calls the trigger's backend with the system and user prompts as the last two arguments, and returns its verdict", async () => {
		const calls: string[][] = [];
		const judge = createJudge({ config: () => defaultJudgeConfig(INF), run: runnerOf('{"verdict":"do_not_retry","reason":"persistent"}', 0, calls) });
		const a = await judge("stalled-recovery", { system: "SYS", user: "USER", verdicts });
		expect(a).toEqual({ ok: true, backend: "haiku", verdict: "do_not_retry", reason: "persistent" });
		expect(calls[0]!.slice(-2)).toEqual(["SYS", "USER"]);
		expect(calls[0]).toContain("--level");
	});
	test("a Custom trigger with no command fails cleanly, naming what is missing", async () => {
		const cfg = parseJudgeConfig(JSON.stringify({ triggers: { "stalled-recovery": { backend: "custom" } } }), defaultJudgeConfig(INF)).config;
		const a = await createJudge({ config: () => cfg, run: runnerOf("{}") })("stalled-recovery", { system: "", user: "", verdicts });
		expect(a).toMatchObject({ ok: false, backend: "custom" });
		expect((a as { error: string }).error).toMatch(/backends\.custom\.command/);
	});
	test("no inference tool installed and no file: a clean failure, never a throw", async () => {
		const a = await createJudge({ config: () => defaultJudgeConfig(undefined), run: runnerOf("{}") })("stalled-recovery", { system: "", user: "", verdicts });
		expect(a).toMatchObject({ ok: false, backend: "haiku" });
	});
	test("a verdict outside the trigger's list, bad JSON, a nonzero exit and a thrown runner are all failures", async () => {
		const cases: JudgeRunner[] = [runnerOf('{"verdict":"merge_it"}'), runnerOf("sorry, no"), runnerOf("", 1), async () => { throw Error("spawn failed"); }];
		for (const run of cases) expect((await createJudge({ config: () => defaultJudgeConfig(INF), run })("stalled-recovery", { system: "", user: "", verdicts })).ok).toBe(false);
	});
	test("it reads the last JSON line, so a backend that logs first still answers", async () => {
		const a = await createJudge({ config: () => defaultJudgeConfig(INF), run: runnerOf('[model] vendor=anthropic\n{"verdict":"retry_later","reason":"r"}\n') })("stalled-recovery", { system: "", user: "", verdicts });
		expect(a).toMatchObject({ ok: true, verdict: "retry_later" });
	});
});

describe("scrubForJudge", () => {
	test("home directories, emails, long tokens and query strings never reach a judge", () => {
		const s = scrubForJudge(`failed in /home/someone/dev/Secret for a@b.co at https://x.test/p?token=xxxxxxxxxxxxxxxxxxxxxxxxxx with key ${"key"}_${"x".repeat(30)}`);
		expect(s).not.toMatch(/someone|a@b\.co|token=|key_x{10}/);
	});
	test("it clips", () => expect(scrubForJudge("word ".repeat(100), 50)).toHaveLength(50));
});

describe("there is one path to a model", () => {
	const SRC = new URL("..", import.meta.url).pathname;
	const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [join(dir, e.name)] : []));
	test("only src/core/judge.ts names the inference tool", () => {
		const hits = walk(SRC).filter((f) => /Inference\.ts|EXAMPLE\/TOOLS/.test(readFileSync(f, "utf8"))).map((f) => relative(SRC, f));
		expect(hits).toEqual(["core/judge.ts"]);
	});
});
