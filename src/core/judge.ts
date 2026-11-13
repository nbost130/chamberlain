/**
 * The one judge. Anything in the daemon that needs a small model's opinion asks it here, by trigger name, and the trigger's
 * configuration says which backend answers. There is no second path to a model: src/core/judge.test.ts fails when another core
 * file spawns one.
 *
 * The backend is an EXPLICIT setting, with no default: `<conf>/judge.json` names each backend's command and which backend judges
 * each trigger, for example
 *   { "triggers": { "stalled-recovery": { "backend": "small-model" } },
 *     "backends": { "small-model": { "command": ["/usr/local/bin/my-judge", "--json"] } } }
 * A backend's command receives the system prompt and the user prompt as its last two arguments and prints one JSON object
 * `{ "verdict": ..., "reason": ... }` on stdout. Backend names are the operator's own. Without the file, or without a trigger in it,
 * that trigger is not judged: the engine logs `judge-off` with why once at start, and every question goes on to a person.
 *
 * Privacy: a judge sees only what `scrubForJudge` leaves of an error message, never thread text. Whether a backend that may retain
 * its input is acceptable is the operator's call, made by naming it in `judge.json`.
 *
 * A judge that cannot answer never blocks anything: the caller gets `{ ok: false }` and sends the question on to a person.
 */
import { readFileSync } from "node:fs";

/** A backend's name: the operator's own, as written in judge.json. */
export type JudgeBackend = string;
export type TriggerConfig = { backend: JudgeBackend };
export type JudgeConfig = { triggers: Record<string, TriggerConfig>; backends: Record<JudgeBackend, { command: string[] }> };

export const TRIGGERS = ["stalled-recovery"] as const;
export type Trigger = (typeof TRIGGERS)[number];

/** A backend name: letters, digits, `.`, `_` and `-`. */
const BACKEND_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** Pure: the configuration without a judge.json. Nothing is judged: there is no default backend. */
export function defaultJudgeConfig(): JudgeConfig {
	return { triggers: {}, backends: {} };
}

/** Pure: why `trigger` is not judged under `config`, or undefined when a backend with a command judges it. */
export function judgeOff(config: JudgeConfig, trigger: Trigger): string | undefined {
	const backend = config.triggers[trigger]?.backend;
	if (!backend) return `judge.json names no backend for the "${trigger}" trigger, so it is not judged: its questions go to a person`;
	if (!config.backends[backend]?.command) return `the "${backend}" backend has no command in judge.json, so the "${trigger}" trigger is not judged: its questions go to a person`;
	return undefined;
}

/** Pure: a judge.json text merged over the defaults, or the first thing wrong with it. */
export function parseJudgeConfig(text: string | undefined, base: JudgeConfig = defaultJudgeConfig()): { config: JudgeConfig; error?: string } {
	if (text === undefined) return { config: base };
	try {
		const raw = JSON.parse(text) as { triggers?: Record<string, { backend?: unknown }>; backends?: Record<string, { command?: unknown }> };
		const config: JudgeConfig = { triggers: { ...base.triggers }, backends: { ...base.backends } };
		for (const [name, b] of Object.entries(raw.backends ?? {})) {
			if (!BACKEND_NAME.test(name)) throw Error(`backend name "${name.slice(0, 64)}" must be letters, digits, ".", "_" or "-"`);
			if (!Array.isArray(b?.command) || !b.command.length || !b.command.every((x) => typeof x === "string" && x.length > 0)) throw Error(`backend "${name}": command must be a non-empty list of strings`);
			config.backends[name] = { command: b.command as string[] };
		}
		for (const [name, t] of Object.entries(raw.triggers ?? {})) {
			if (!(TRIGGERS as readonly string[]).includes(name)) throw Error(`unknown trigger "${name}"`);
			if (typeof t?.backend !== "string" || !BACKEND_NAME.test(t.backend)) throw Error(`trigger "${name}": backend must name a backend`);
			if (!config.backends[t.backend]) throw Error(`trigger "${name}": backend "${t.backend}" is not in "backends"`);
			config.triggers[name] = { backend: t.backend };
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
