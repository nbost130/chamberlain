/** sweep, continued: see sweep.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { sweep } from "../../testing/core-sweep-fixtures.ts";
import { git, gitTestEnv } from "../../testing/git.ts";
import { memStore } from "../../testing/store.ts";
import {
	checkSource,
	commitsAheadCommand,
	configuredSources,
	type exec,
	parseCheckOutput,
	sweepClock,
} from "./sweep.ts";

describe("operator checks", () => {
	test("output is bounded and validated", () => {
		const f = parseCheckOutput(JSON.stringify([{ dedupKey: "low", text: "x".repeat(900), repeatIntervalMs: 0 }]));
		expect(f).toEqual([{ dedupKey: "low", text: "x".repeat(400), repeatIntervalMs: 0 }]);
		expect(parseCheckOutput("")).toEqual([]);
		expect(() => parseCheckOutput("{}")).toThrow("not a JSON array");
		expect(() => parseCheckOutput('[{"dedupKey":"a"}]')).toThrow("needs a string dedupKey and text");
	});
	test("a finding may ask for a repeat interval, a baseline and a subject, and nothing else", () => {
		expect(
			parseCheckOutput(
				JSON.stringify([
					{
						dedupKey: "a",
						text: "t",
						repeatIntervalMs: 3600000,
						maxNotifications: 3,
						baseline: true,
						subject: { kind: "pr", id: "7" },
					},
				]),
			),
		).toEqual([
			{
				dedupKey: "a",
				text: "t",
				repeatIntervalMs: 3600000,
				maxNotifications: 3,
				baseline: true,
				subject: { kind: "pr", id: "7" },
			},
		]);
		expect(() => parseCheckOutput('[{"dedupKey":"a","text":"t","extra":1}]')).toThrow('unknown field "extra"');
		expect(() => parseCheckOutput('[{"dedupKey":"a","text":"t","repeatIntervalMs":-1}]')).toThrow("repeatIntervalMs");
		expect(() => parseCheckOutput('[{"dedupKey":"a","text":"t","maxNotifications":2}]')).toThrow(
			"goes with repeatIntervalMs",
		);
		expect(() => parseCheckOutput('[{"dedupKey":"a","text":"t","subject":{"kind":"pr"}}]')).toThrow("subject");
	});
	test("every refusal of a finding names it and the field", () => {
		const refused = (finding: unknown, message: string) =>
			expect(() => parseCheckOutput(JSON.stringify([{ dedupKey: "ok", text: "t" }, finding]))).toThrow(Error(message));
		refused(null, "finding 2 is not an object");
		refused([], "finding 2 is not an object");
		refused("x", "finding 2 is not an object");
		refused({ dedupKey: "", text: "t" }, "finding 2 needs a string dedupKey and text");
		refused({ dedupKey: "a", text: 4 }, "finding 2 needs a string dedupKey and text");
		const interval = "finding 2: repeatIntervalMs must be a number of milliseconds, 0 or more";
		refused({ dedupKey: "a", text: "t", repeatIntervalMs: "1" }, interval);
		refused({ dedupKey: "a", text: "t", repeatIntervalMs: -1 }, interval);
		const max = "finding 2: maxNotifications must be a whole number, 1 or more, and goes with repeatIntervalMs";
		refused({ dedupKey: "a", text: "t", repeatIntervalMs: 1, maxNotifications: 0 }, max);
		refused({ dedupKey: "a", text: "t", repeatIntervalMs: 1, maxNotifications: 1.5 }, max);
		refused({ dedupKey: "a", text: "t", repeatIntervalMs: 1, maxNotifications: "2" }, max);
		refused({ dedupKey: "a", text: "t", maxNotifications: 2 }, max);
		refused({ dedupKey: "a", text: "t", baseline: "yes" }, "finding 2: baseline must be true or false");
		const subject = 'finding 2: subject must be {"kind", "id"}';
		refused({ dedupKey: "a", text: "t", subject: "pr" }, subject);
		refused({ dedupKey: "a", text: "t", subject: { kind: "pr", id: 7 } }, subject);
		refused({ dedupKey: "a", text: "t", subject: { id: "7" } }, subject);
	});
	test("what a finding does not ask for is left out, and the texts are cut", () => {
		expect(
			parseCheckOutput(
				JSON.stringify([
					{ dedupKey: "k".repeat(300), text: "t", baseline: false, repeatIntervalMs: 5, maxNotifications: 1 },
					{ dedupKey: "b", text: "t", subject: { kind: "pr", id: "1", extra: true } },
				]),
			),
		).toEqual([
			{ dedupKey: "k".repeat(200), text: "t", repeatIntervalMs: 5, maxNotifications: 1 },
			{ dedupKey: "b", text: "t", subject: { kind: "pr", id: "1" } },
		]);
	});
	test("a check that fails or prints nonsense is in error, never clear", async () => {
		const run = (async (cmd: string) => {
			if (cmd === "ok") return '[{"dedupKey":"a","text":"found"}]';
			if (cmd === "bad") return "not json";
			throw Error("exited 1");
		}) as typeof exec;
		const store = memStore();
		const sources = [
			{ name: "ok", command: ["ok"] },
			{ name: "bad", command: ["bad"] },
			{ name: "dead", command: ["dead"] },
		].map((c) => checkSource(c, run));
		const a = await sweep(store, sources);
		expect(a.fresh.map((x) => x.item)).toEqual([
			"check:ok/a",
			"check:bad/evaluation_error",
			"check:dead/evaluation_error",
		]);
		expect(a.errored).toEqual(["check:bad", "check:dead"]);
		expect(a.fresh[2]!.text).toBe("A routine check could not run: check:dead: exited 1.");
	});
	test("a real command runs without a shell", async () => {
		const dir = mkdtempSync(`${tmpdir()}/sweepchk-`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			`${dir}/sweep.json`,
			JSON.stringify({ checks: [{ name: "echo", command: ["/bin/echo", '[{"dedupKey":"k","text":"from echo"}]'] }] }),
			{ mode: 0o600 },
		);
		const store = memStore();
		const a = await sweep(store, configuredSources(dir));
		expect(a.fresh).toEqual([{ item: "check:echo/k", text: "from echo" }]);
		expect(a.errored).toEqual([]);
	});
	test("a broken sweep.json is a source in error, not a crash", async () => {
		const dir = mkdtempSync(`${tmpdir()}/sweepbad-`);
		writeFileSync(`${dir}/sweep.json`, "{", { mode: 0o600 });
		const a = await sweep(memStore(), configuredSources(dir));
		expect(a.errored).toEqual(["sweep.json"]);
		expect(a.fresh[0]!.text).toStartWith("A routine check could not run: sweep.json:");
	});
});

describe("commitsAheadCommand", () => {
	test("quotes a path with spaces and a quote", () =>
		expect(commitsAheadCommand("/tmp/a b'c")).toStartWith("cd '/tmp/a b'\\''c' && "));
	test("really counts branch commits in a repository", () => {
		const dir = mkdtempSync(`${tmpdir()}/ahead-`);
		git(dir, "init", "-q", "-b", "main");
		git(dir, "commit", "-q", "--allow-empty", "-m", "one");
		git(dir, "update-ref", "refs/remotes/origin/main", "main");
		git(dir, "switch", "-q", "-c", "work");
		git(dir, "commit", "-q", "--allow-empty", "-m", "two");
		git(dir, "commit", "-q", "--allow-empty", "-m", "three");
		// The command under test is a shell line that runs plain `git`: give it the same sealed environment, not the run's own.
		const p = Bun.spawnSync(["/bin/sh", "-c", commitsAheadCommand(dir)], {
			env: gitTestEnv(),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(p.stdout.toString().trim()).toBe("2");
	});
});

describe("sweepClock", () => {
	const NOW = 1_000_000;
	test("the first sweep ever starts both clocks and is not seeded", () =>
		expect(sweepClock(undefined, NOW)).toEqual({ lastAt: NOW, lastFullAt: NOW, seeded: false }));
	test("a current record keeps its clocks, so a daemon outage is still swept", () => {
		expect(sweepClock({ lastAt: 5, lastFullAt: 3, seeded: true }, NOW)).toEqual({
			lastAt: 5,
			lastFullAt: 3,
			seeded: true,
		});
	});
	test("a damaged record heals instead of failing every minute", () => {
		expect(sweepClock({ lastAt: "x", lastFullAt: Number.NaN, seeded: "yes" } as never, NOW)).toEqual({
			lastAt: NOW,
			lastFullAt: NOW,
			seeded: false,
		});
	});
});
