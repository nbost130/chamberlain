import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertNoTools,
	type CliRunner,
	claudeArgv,
	MODEL_ID,
	parseReply,
	replyUsage,
	reportedModels,
	runClaude,
	spawnCli,
} from "./cli.ts";

const ARGV = claudeArgv({ command: "claude", model: "haiku", system: "You label one message." });

describe("the no-tools rule is written once, in claudeArgv", () => {
	test("the argv, flag for flag: a bare one-shot reader with no tools, settings, MCP servers, commands or session file", () => {
		expect(ARGV).toEqual([
			"claude",
			"-p",
			"--model",
			"haiku",
			"--setting-sources",
			"",
			"--tools",
			"",
			"--strict-mcp-config",
			"--disable-slash-commands",
			"--no-session-persistence",
			"--system-prompt",
			"You label one message.",
			"--output-format",
			"json",
		]);
		expect(ARGV).not.toContain("--bare");
		expect(() => assertNoTools(ARGV)).not.toThrow();
	});

	test("the model is a parameter, and only the model, the command and the system prompt vary", () => {
		const other = claudeArgv({ command: "/opt/claude", model: "claude-sonnet-5-5", system: "S" });
		expect(other.slice(0, 4)).toEqual(["/opt/claude", "-p", "--model", "claude-sonnet-5-5"]);
		expect(other.length).toBe(ARGV.length);
	});

	test("an argv missing any guard is refused, whatever else it holds", () => {
		const without = (flag: string, withValue: boolean) => {
			const i = ARGV.indexOf(flag);
			return ARGV.filter((_, k) => k !== i && !(withValue && k === i + 1));
		};
		expect(() => assertNoTools(without("--tools", true))).toThrow('--tools ""');
		expect(() => assertNoTools(without("--setting-sources", true))).toThrow('--setting-sources ""');
		for (const f of ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"])
			expect(() => assertNoTools(without(f, false))).toThrow(f);
		// A tool list that is not empty is not "no tools".
		const some = [...ARGV];
		some[some.indexOf("--tools") + 1] = "Bash,Read";
		expect(() => assertNoTools(some)).toThrow('--tools ""');
		// A flag that is last has no value, which is not the empty one either.
		expect(() => assertNoTools(["claude", "-p", "--setting-sources", "", "--tools"])).toThrow('--tools ""');
	});

	test("a guard that is repeated, overridden or joined by another flag is refused: the argv is exactly claudeArgv's", () => {
		for (const extra of [
			["--tools", "Bash"],
			["--setting-sources", "user"],
			["--tools", ""],
			["--mcp-config", "x.json"],
			["--settings", "{}"],
			["--allowedTools", "Bash"],
			["--dangerously-skip-permissions"],
			["--bare"],
		])
			expect(() => assertNoTools([...ARGV, ...extra]), extra.join(" ")).toThrow("exactly the one claudeArgv builds");
		// An extra flag before the system prompt shifts the rest, which is not the argv either.
		expect(() => assertNoTools([...ARGV.slice(0, 2), "--tools", "Bash", ...ARGV.slice(2)])).toThrow();
		expect(() => assertNoTools(ARGV.slice(0, -2))).toThrow("exactly the one claudeArgv builds");
	});

	test("the real runner refuses an unsafe argv before it spawns anything", async () => {
		const dir = mkdtempSync(join(tmpdir(), "llm-cli-"));
		const marker = join(dir, "ran");
		await expect(spawnCli(["sh", "-c", `touch ${marker}`], { stdin: "", env: {}, timeoutMs: 5000 })).rejects.toThrow(
			'--tools ""',
		);
		expect(existsSync(marker)).toBe(false);
	});
});

describe("runClaude: one call, a fixed phrase for every failure", () => {
	const call = (run: CliRunner) => ({
		command: "claude",
		model: "haiku",
		system: "S",
		stdin: "the text to read",
		env: { PATH: "/usr/bin" },
		timeoutMs: 1234,
		run,
	});

	test("the text goes on stdin and never in argv; the environment and the timeout are the caller's", async () => {
		const seen: { argv: string[]; o: Parameters<CliRunner>[1] }[] = [];
		const out = await runClaude(
			call(async (argv, o) => {
				seen.push({ argv, o });
				return { code: 0, stdout: "{}" };
			}),
		);
		expect(out).toBe("{}");
		expect(seen[0]?.argv.join(" ")).not.toContain("the text to read");
		expect(seen[0]?.o).toEqual({ stdin: "the text to read", env: { PATH: "/usr/bin" }, timeoutMs: 1234 });
		expect(seen[0]?.argv).toEqual(claudeArgv({ command: "claude", model: "haiku", system: "S" }));
	});

	test("a run that cannot start, a timeout and a failing exit each say a fixed phrase, never output", async () => {
		await expect(
			runClaude(
				call(async () => {
					throw Error("secret: the mail said so");
				}),
			),
		).rejects.toThrow(/^claude could not be run$/);
		await expect(runClaude(call(async () => ({ code: null, stdout: "partial mail text" })))).rejects.toThrow(
			/^claude did not finish within 1234 ms$/,
		);
		await expect(runClaude(call(async () => ({ code: 3, stdout: "partial mail text" })))).rejects.toThrow(
			/^claude exited 3$/,
		);
	});
});

describe("the reply", () => {
	test("it must be a JSON object", () => {
		expect(parseReply("claude", '{"result":"x"}')).toEqual({ result: "x" });
		expect(() => parseReply("claude", "nope")).toThrow("claude printed something that is not JSON");
		expect(() => parseReply("claude", "null")).toThrow("claude printed JSON that is not an object");
	});

	test("usage adds input, cache-written and cache-read tokens; anything not a finite non-negative number counts as zero", () => {
		expect(
			replyUsage({
				usage: { input_tokens: 900, cache_creation_input_tokens: 50, cache_read_input_tokens: 100 },
				total_cost_usd: 0.5,
			}),
		).toEqual({ inputTokens: 1050, costUsd: 0.5 });
		expect(replyUsage({ usage: { input_tokens: -1, cache_read_input_tokens: "7" }, total_cost_usd: -2 })).toEqual({});
		expect(replyUsage({ total_cost_usd: 0 })).toEqual({ costUsd: 0 });
	});

	test("the models a reply says answered, in order, and the shape a model id may take", () => {
		expect(reportedModels({ modelUsage: { "claude-haiku-5-5": {}, "claude-sonnet-5-5": {} } })).toEqual([
			"claude-haiku-5-5",
			"claude-sonnet-5-5",
		]);
		expect(reportedModels({})).toEqual([]);
		expect(MODEL_ID.test("claude-haiku-5-5")).toBe(true);
		expect(MODEL_ID.test("haiku")).toBe(true);
		for (const bad of ["", "-x", "a b", "a;rm", `a${"b".repeat(80)}`, "line\nbreak"])
			expect(MODEL_ID.test(bad)).toBe(false);
	});
});
