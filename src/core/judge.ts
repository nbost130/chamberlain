/**
 * The one judge. Anything in the daemon that needs a small model's opinion asks it here, by trigger name, and the trigger's
 * configuration says which backend answers: Haiku (the cheap tier of the inference tool) or Custom. There is no second path to a
 * model: src/core/judge.test.ts fails when another core file spawns one.
 *
 * Configuration is `<conf>/judge.json`, optional:
 *   { "triggers": { "stalled-recovery": { "backend": "haiku" } },
 *     "backends": { "haiku": { "command": ["bun", "/path/Inference.ts", "--level", "low", "--json", "--vendor", "anthropic", "--no-fallback"] },
 *                   "custom":   { "command": ["/path/to/custom-judge"] } } }
 * A backend's command receives the system prompt and the user prompt as its last two arguments and prints one JSON object
 * `{ "verdict": ..., "reason": ... }` on stdout. Without a file, `stalled-recovery` goes to Haiku through the inference tool at
 * ~/bin/example-inference when it exists, and there is no Custom command until the file names one.
 *
 * Privacy, and an open point: a judge sees only what `scrubForJudge` leaves of an error message, never thread text. Haiku is the
 * default for the recovery trigger because Custom may retain its input, and an error message can carry a path or a fragment of
 * work. Whether Custom may judge this trigger is the principal's call, made by editing `judge.json`.
 *
 * A judge that cannot answer never blocks anything: the caller gets `{ ok: false }` and sends the question on to a person.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

export type JudgeBackend = "haiku" | "custom";
export type TriggerConfig = { backend: JudgeBackend };
export type JudgeConfig = { triggers: Record<string, TriggerConfig>; backends: Partial<Record<JudgeBackend, { command: string[] }>> };

export const TRIGGERS = ["stalled-recovery"] as const;
export type Trigger = (typeof TRIGGERS)[number];

const INFERENCE = `${homedir()}/bin/example-inference`;

/** Pure: the configuration with every default filled in. `inference` is where the inference tool is, or undefined when it is not installed. */
export function defaultJudgeConfig(inference: string | undefined = existsSync(INFERENCE) ? INFERENCE : undefined): JudgeConfig {
	return {
		triggers: { "stalled-recovery": { backend: "haiku" } },
		backends: inference ? { haiku: { command: [process.execPath, inference, "--level", "low", "--json", "--vendor", "anthropic", "--no-fallback"] } } : {},
	};
}

/** Pure: a judge.json text merged over the defaults, or the first thing wrong with it. */
export function parseJudgeConfig(text: string | undefined, base: JudgeConfig = defaultJudgeConfig()): { config: JudgeConfig; error?: string } {
	if (text === undefined) return { config: base };
	try {
		const raw = JSON.parse(text) as { triggers?: Record<string, { backend?: unknown }>; backends?: Record<string, { command?: unknown }> };
		const config: JudgeConfig = { triggers: { ...base.triggers }, backends: { ...base.backends } };
		for (const [name, t] of Object.entries(raw.triggers ?? {})) {
			if (!(TRIGGERS as readonly string[]).includes(name)) throw Error(`unknown trigger "${name}"`);
			if (t?.backend !== "haiku" && t?.backend !== "custom") throw Error(`trigger "${name}": backend must be "haiku" or "custom"`);
			config.triggers[name] = { backend: t.backend };
		}
		for (const [name, b] of Object.entries(raw.backends ?? {})) {
			if (name !== "haiku" && name !== "custom") throw Error(`unknown backend "${name}"`);
			if (!Array.isArray(b?.command) || !b.command.length || !b.command.every((x) => typeof x === "string")) throw Error(`backend "${name}": command must be a non-empty list of strings`);
			config.backends[name] = { command: b.command as string[] };
		}
		return { config };
	} catch (e) {
		return { config: base, error: `judge.json: ${e instanceof Error ? e.message : String(e)}` };
	}
}

export function readJudgeConfig(conf: string): { config: JudgeConfig; error?: string } {
	try {
		return parseJudgeConfig(readFileSync(`${conf}/judge.json`, "utf8"));
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return { config: defaultJudgeConfig() };
		return { config: defaultJudgeConfig(), error: `judge.json: ${String(e).slice(0, 120)}` };
	}
}

/**
 * Pure: an error message with what a judge has no need of removed. Home directories, long hex or token-like strings, email
 * addresses and URLs' query strings go; the rest is clipped. The message was already only the backend's own error text.
 */
export function scrubForJudge(message: string, max = 200): string {
	return message
		.replace(/\/(?:home|Users)\/[^\s/'"]+/g, "~")
		.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
		.replace(/\?[^\s'"]+/g, "?[query]")
		.replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[token]")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

export type JudgeRunner = (argv: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
export const spawnRunner: JudgeRunner = async (argv, timeoutMs) => {
	const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
	const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
	return { code, stdout, stderr };
};

export type JudgeAnswer = { ok: true; backend: JudgeBackend; verdict: string; reason: string } | { ok: false; backend: JudgeBackend | "none"; error: string };
export type JudgeInput = { system: string; user: string; /** The verdicts this trigger accepts; any other answer is a failure. */ verdicts: readonly string[] };

export type JudgeDeps = { config: () => JudgeConfig; run?: JudgeRunner; timeoutMs?: number; log?: (event: string, data?: Record<string, unknown>) => void };

/** The one judge: `judge(trigger, input)`. */
export function createJudge(d: JudgeDeps) {
	const run = d.run ?? spawnRunner;
	return async function judge(trigger: Trigger, input: JudgeInput): Promise<JudgeAnswer> {
		const cfg = d.config();
		const backend = cfg.triggers[trigger]?.backend;
		if (!backend) return { ok: false, backend: "none", error: `no judge configured for trigger ${trigger}` };
		const command = cfg.backends[backend]?.command;
		if (!command) return { ok: false, backend, error: `the ${backend} backend has no command (judge.json backends.${backend}.command)` };
		try {
			const r = await run([...command, input.system, input.user], d.timeoutMs ?? 45_000);
			if (r.code !== 0) return { ok: false, backend, error: `${backend} judge exited ${r.code}: ${r.stderr.trim().slice(0, 160)}` };
			const out = JSON.parse(r.stdout.trim().split("\n").filter(Boolean).at(-1) ?? "") as { verdict?: unknown; reason?: unknown };
			if (typeof out.verdict !== "string" || !input.verdicts.includes(out.verdict)) return { ok: false, backend, error: `${backend} judge gave verdict ${JSON.stringify(out.verdict)}, not one of ${input.verdicts.join(", ")}` };
			return { ok: true, backend, verdict: out.verdict, reason: typeof out.reason === "string" ? out.reason.slice(0, 300) : "" };
		} catch (e) {
			d.log?.("judge-failed", { trigger, backend, error: String(e).slice(0, 200) });
			return { ok: false, backend, error: `${backend} judge failed: ${String(e instanceof Error ? e.message : e).slice(0, 160)}` };
		}
	};
}
export type Judge = ReturnType<typeof createJudge>;
