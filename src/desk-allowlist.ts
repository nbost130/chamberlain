/**
 * The Alert Desk's command allowlist, enforced in code: a Claude Code PreToolUse hook for the desk thread's project (and so for the
 * `example-gatherer` gatherers it starts). The standing prompt (docs/alert-desk-prompt.md) tells the desk what it may run; this is what refuses
 * the rest, so a gatherer that has been talked into something by an alert's text still cannot do it.
 *
 *   bun src/desk-allowlist.ts hook            reads the hook's JSON on stdin; exit 2 with the reason on stderr refuses the call
 *   bun src/desk-allowlist.ts check '<cmd>'   one command by hand: prints allow or the reason, exit 0 or 2
 *
 * The rule is a FIXED SET OF COMMAND SHAPES, not a list of dangerous things. A command is one simple command, tokenized here with the quoting
 * rules a POSIX shell applies to the subset accepted (no expansion, substitution, redirection, chaining or globbing outside quotes, and none of
 * `$`, a backtick or a backslash inside them), whose name is in SHAPES and whose every flag is one that shape lists. The one pipe allowed is a
 * final `head -n N`, `tail -n N` or `wc -l`. Anything else is refused with the first thing wrong.
 *
 * File reads (the Read, Grep and Glob tools) are allowed only under LOG_DIRS, after `..` and symlinks are resolved, and never for a path with a
 * component that names a credential (.env, keys, tokens, ssh, gnupg, aws, passage...). The desk fixes nothing, so the write tools are refused.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type Verdict = { ok: true } | { ok: false; reason: string };
const ok: Verdict = { ok: true };
const no = (reason: string): Verdict => ({ ok: false, reason });

const HOME = process.env.HOME ?? "";
/** The only places a file may be read from. */
/** Colon-separated extra directories in DESK_LOG_DIRS. */
export const LOG_DIRS = ["/var/log", `${HOME}/.cache/alert-desk`, ...(process.env.DESK_LOG_DIRS ?? "").split(":").filter(Boolean)];
/** A path component that names a credential: refused even inside a log directory. */
const SECRET_NAME = /^(\.env(\..*)?|.*\.(pem|key|p12|pfx|kdbx|age)|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|\.?credentials?(\..*)?|\.?secrets?(\..*)?|\.netrc|\.npmrc|\.git-credentials|.*token.*|.*passw(or)?d.*|.*\.secret|\.ssh|\.gnupg|\.aws|\.password-store|passage|read-token)$/i;

// ---- tokenizing --------------------------------------------------------------------------------------

/** Splits on unquoted `|` and tokenizes each part, or says what is wrong. Quoted text is literal; an unquoted metacharacter is refused. */
function tokenize(cmd: string): { parts: string[][] } | { error: string } {
	const parts: string[][] = [[]];
	let cur = "", inTok = false, q: "" | "'" | '"' = "";
	const push = () => { if (inTok) parts[parts.length - 1]!.push(cur); cur = ""; inTok = false; };
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd[i]!;
		if (q === "'") { if (c === "'") q = ""; else cur += c; continue; }
		if (q === '"') {
			if (c === '"') q = "";
			else if (c === "$" || c === "`" || c === "\\") return { error: "a $, backtick or backslash inside double quotes expands" };
			else cur += c;
			continue;
		}
		if (c === "'" || c === '"') { q = c; inTok = true; continue; }
		if (c === " " || c === "\t") { push(); continue; }
		if (c === "|") {
			if (cmd[i + 1] === "|") return { error: "|| chains commands" };
			push(); parts.push([]); continue;
		}
		if (/[;&<>(){}$`\\*?[\]!~#\n\r]/.test(c)) return { error: `an unquoted ${JSON.stringify(c)} is shell syntax (chaining, redirection, expansion or a glob)` };
		cur += c; inTok = true;
	}
	if (q) return { error: "an unclosed quote" };
	push();
	if (parts.some((p) => p.length === 0)) return { error: "an empty command around a pipe" };
	return { parts };
}

// ---- flag specs --------------------------------------------------------------------------------------

type Flag = "bool" | RegExp;
type Spec = { flags: Record<string, Flag>; /** Positional arguments: each must match, at most `max`. */ positional?: RegExp; max?: number; min?: number };
const DIGITS = /^\d{1,6}$/;
const TIME = /^[\w:. +-]{1,40}$/;
const UNIT = /^[A-Za-z0-9@_.:-]{1,100}$/;
const WORD = /^[A-Za-z0-9_.@:-]{1,64}$/;
const REPO = /^[\w.-]{1,60}\/[\w.-]{1,100}$/;

/** Checks `args` against a spec: every flag listed, its value valid, every positional valid. Returns the positionals, or the first fault. */
function against(args: string[], spec: Spec, what: string): { pos: string[] } | Verdict {
	const pos: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a.startsWith("-")) {
			const eq = a.startsWith("--") ? a.indexOf("=") : -1;
			const name = eq > 0 ? a.slice(0, eq) : a;
			const rule = spec.flags[name];
			if (rule === undefined) return no(`${what}: the flag ${name} is not on the allowlist`);
			if (rule === "bool") { if (eq > 0) return no(`${what}: ${name} takes no value`); continue; }
			const value = eq > 0 ? a.slice(eq + 1) : args[++i];
			if (value === undefined || !rule.test(value)) return no(`${what}: the value of ${name} is not allowed`);
			continue;
		}
		if (!spec.positional || !spec.positional.test(a)) return no(`${what}: the argument ${JSON.stringify(a.slice(0, 40))} is not allowed`);
		pos.push(a);
	}
	if (spec.max !== undefined && pos.length > spec.max) return no(`${what}: too many arguments`);
	if (spec.min !== undefined && pos.length < spec.min) return no(`${what}: missing an argument`);
	return { pos };
}
const isVerdict = (x: { pos: string[] } | Verdict): x is Verdict => "ok" in x;

/** `docker inspect --format` and `docker ps --format`: literal text and `{{.Field}}` for these fields only. No `json`, no `range`, no object that holds the environment. */
const INSPECT_FIELDS = ["Name", "RestartCount", "State.Status", "State.Running", "State.Restarting", "State.OOMKilled", "State.ExitCode", "State.StartedAt", "State.FinishedAt", "State.Health.Status", "Config.Image", "HostConfig.RestartPolicy.Name", "Created"];
const PS_FIELDS = ["Names", "Status", "State", "Image", "RunningFor", "ID", "CreatedAt", "Ports"];
const formatOk = (fmt: string, fields: string[]) => new RegExp(`^(?:[^{}$\`\\\\]|\\{\\{\\.(?:${fields.map((f) => f.replace(/\./g, "\\.")).join("|")})\\}\\})*$`).test(fmt) && fmt.length <= 300;

// ---- the command shapes ------------------------------------------------------------------------------

const journalctl: Spec = {
	flags: { "--user": "bool", "--no-pager": "bool", "-r": "bool", "--reverse": "bool", "-u": UNIT, "--unit": UNIT, "-n": DIGITS, "--lines": DIGITS, "--since": TIME, "--until": TIME, "-p": /^[a-z0-9.]{1,20}$/, "--priority": /^[a-z0-9.]{1,20}$/, "-o": /^(short|short-iso|short-precise|cat)$/, "--output": /^(short|short-iso|short-precise|cat)$/ },
};
const gitDiffLike: Spec = {
	flags: { "--stat": "bool", "--shortstat": "bool", "--name-only": "bool", "--name-status": "bool", "--oneline": "bool", "--no-color": "bool", "-n": DIGITS, "--max-count": DIGITS, "--since": TIME, "--until": TIME },
	positional: /^[A-Za-z0-9._/@~^{}-]{1,100}$/, max: 4,
};

function checkSimple(tokens: string[]): Verdict {
	const [name, ...args] = tokens;
	if (!name || name.includes("/") || name.includes("=")) return no("the command must be a bare name from the allowlist");
	switch (name) {
		case "journalctl": {
			const r = against(args, journalctl, "journalctl");
			return isVerdict(r) ? r : ok;
		}
		case "systemctl": {
			const rest = [...args];
			const flags: Spec = { flags: { "--user": "bool", "--no-pager": "bool", "-l": "bool", "--full": "bool", "-n": DIGITS, "--failed": "bool" }, positional: UNIT };
			const sub = rest.find((a) => !a.startsWith("-") && !DIGITS.test(a));
			if (!sub || !["status", "is-active", "is-failed", "list-units"].includes(sub)) return no(`systemctl: only status, is-active, is-failed and list-units are allowed (not ${JSON.stringify(sub ?? "")}); cat and show print unit files and environments`);
			const r = against(rest.filter((a) => a !== sub), flags, "systemctl");
			if (isVerdict(r)) return r;
			if (sub === "list-units" && r.pos.length) return no("systemctl list-units takes no unit");
			if (sub !== "list-units" && r.pos.length === 0) return no(`systemctl ${sub} needs a unit`);
			return ok;
		}
		case "example-tool": {
			const [sub, ...rest] = args;
			if (sub === undefined) return ok;
			if (sub === "update" || sub.startsWith("-")) return no("example-tool: only its read commands are allowed");
			const shapes: Record<string, Spec> = {
				health: { flags: {}, positional: WORD, max: 1 }, docker: { flags: {}, max: 0 }, service: { flags: {}, positional: WORD, max: 1, min: 1 }, estate: { flags: {}, max: 0 },
				network: { flags: {}, positional: /^ports$/, max: 1 }, process: { flags: {}, max: 0 }, redis: { flags: {}, max: 0 }, journal: { flags: { "--limit": DIGITS }, positional: WORD, max: 1, min: 1 },
			};
			const spec = shapes[sub];
			if (!spec) return no(`example-tool: ${JSON.stringify(sub.slice(0, 30))} is not a read command on the allowlist`);
			const r = against(rest, spec, `example-tool ${sub}`);
			return isVerdict(r) ? r : ok;
		}
		case "gh": {
			const [a, b, ...rest] = args;
			const repo = { "--repo": REPO } as Record<string, Flag>;
			if (a === "run" && b === "view") { const r = against(rest, { flags: { ...repo, "--log-failed": "bool" }, positional: DIGITS, max: 1, min: 1 }, "gh run view"); return isVerdict(r) ? r : ok; }
			if (a === "run" && b === "list") { const r = against(rest, { flags: { ...repo, "--limit": DIGITS }, max: 0 }, "gh run list"); return isVerdict(r) ? r : ok; }
			if (a === "pr" && b === "checks") { const r = against(rest, { flags: repo, positional: DIGITS, max: 1, min: 1 }, "gh pr checks"); return isVerdict(r) ? r : ok; }
			return no("gh: only `run view`, `run list` and `pr checks` are allowed");
		}
		case "git": {
			const [sub, ...rest] = args;
			if (!sub || !["status", "log", "diff"].includes(sub)) return no("git: only status, log and diff are allowed");
			// A `--` ends the flags; what follows is relative paths inside the repo, never `..` or an absolute path.
			const dd = rest.indexOf("--");
			const before = dd < 0 ? rest : rest.slice(0, dd), paths = dd < 0 ? [] : rest.slice(dd + 1);
			if (paths.some((p) => !/^[A-Za-z0-9._/-]{1,200}$/.test(p) || p.startsWith("/") || p.split("/").includes(".."))) return no("git: a path after -- must be relative, inside the repo");
			const r = against(before, sub === "status" ? { flags: {}, max: 0 } : gitDiffLike, `git ${sub}`);
			return isVerdict(r) ? r : ok;
		}
		case "docker": {
			const [sub, ...rest] = args;
			if (sub === "ps") { const r = against(rest, { flags: { "-a": "bool", "--all": "bool", "--no-trunc": "bool", "--format": /^.+$/ }, max: 0 }, "docker ps"); if (isVerdict(r)) return r; const f = rest.findIndex((a) => a === "--format" || a.startsWith("--format=")); if (f >= 0) { const v = rest[f]!.includes("=") ? rest[f]!.slice(rest[f]!.indexOf("=") + 1) : rest[f + 1]!; if (!formatOk(v, PS_FIELDS)) return no("docker ps: the --format may use only plain fields"); } return ok; }
			if (sub === "logs") { const r = against(rest, { flags: { "--tail": DIGITS, "--since": TIME, "--until": TIME, "-t": "bool", "--timestamps": "bool" }, positional: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/, max: 1, min: 1 }, "docker logs"); return isVerdict(r) ? r : ok; }
			if (sub === "inspect") {
				const r = against(rest, { flags: { "--format": /^.+$/, "-f": /^.+$/ }, positional: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/, min: 1, max: 6 }, "docker inspect");
				if (isVerdict(r)) return r;
				const i = rest.findIndex((a) => a === "--format" || a === "-f" || a.startsWith("--format="));
				if (i < 0) return no("docker inspect: a --format is required, because the full document holds the container's environment");
				const v = rest[i]!.startsWith("--format=") ? rest[i]!.slice(9) : rest[i + 1]!;
				return formatOk(v, INSPECT_FIELDS) ? ok : no("docker inspect: the --format may use only the listed plain fields (never Config.Env, Config, json or the whole object)");
			}
			return no("docker: only ps, logs and inspect are allowed");
		}
		default:
			return no(`${JSON.stringify(name.slice(0, 40))} is not on the allowlist`);
	}
}

/** The few commands that are not simple flag shapes, matched whole. */
const MONITOR = `${HOME}/bin/example-monitor`;
const askPath = () => process.env.DESK_ASK_PATH ?? `${HOME}/Projects/chamberlain/src/ask.ts`;
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EXACT: { name: string; re: () => RegExp }[] = [
	{ name: "monitor heartbeat", re: () => new RegExp(`^bun ${escRe(MONITOR)} heartbeat --json$`) },
	{ name: "monitor list", re: () => new RegExp(`^bun ${escRe(MONITOR)} list --limit \\d{1,5} --json$`) },
	{ name: "monitoring notifications", re: () => /^docker exec -u svc db1 bash -lc "printf 'GET log\\nColumns: time host_name service_description state plugin_output\\nFilter: class = 3\\nFilter: time >= \d{9,11}\\nOutputFormat: csv\\n' \| lq"$/ },
	{ name: "the decision queue", re: () => new RegExp(`^bun ${escRe(askPath())} '[^']{1,8000}'$`) },
];

/** Is this one shell command allowed? */
export function checkCommand(cmd: unknown): Verdict {
	if (typeof cmd !== "string" || !cmd.trim()) return no("no command");
	const c = cmd.trim();
	if (c.length > 9000) return no("the command is too long");
	const hit = EXACT.find((e) => e.re().test(c));
	if (hit) return ok;
	const t = tokenize(c);
	if ("error" in t) return no(t.error);
	const [first, ...pipes] = t.parts;
	if (pipes.length > 1) return no("at most one pipe, into head, tail or wc");
	if (pipes.length === 1) {
		const [p, ...a] = pipes[0]!;
		const tail = a.join(" ");
		if (!((p === "head" || p === "tail") && /^-n \d{1,5}$/.test(tail)) && !(p === "wc" && tail === "-l")) return no("a pipe may only go into `head -n N`, `tail -n N` or `wc -l`");
	}
	return checkSimple(first!);
}

// ---- file reads --------------------------------------------------------------------------------------

/** Resolves `..` and symlinks (of the path, or of its nearest existing parent). */
function real(p: string): string {
	let cur = resolve(p), tail = "";
	while (!existsSync(cur) && dirname(cur) !== cur) { tail = `${cur.slice(dirname(cur).length)}${tail}`; cur = dirname(cur); }
	try { return realpathSync(cur) + tail; } catch { return resolve(p); }
}
const logDirs = () => LOG_DIRS.map((d) => { try { return realpathSync(d); } catch { return resolve(d); } });

/** May this path be read? Absolute, under a log directory once resolved, and with no component that names a credential. */
export function checkPath(p: unknown): Verdict {
	if (typeof p !== "string" || !p.startsWith("/")) return no("a read needs an absolute path");
	const r = real(p);
	if (!logDirs().some((d) => r === d || r.startsWith(`${d}/`))) return no(`${p} is not under a log directory (${LOG_DIRS.join(", ")})`);
	const bad = r.split("/").find((seg) => seg && SECRET_NAME.test(seg));
	return bad ? no(`${p} has a component (${bad}) that names a credential`) : ok;
}

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
/** The hook's decision for one tool call. Tools the desk uses that read nothing and run nothing (Agent, ToolSearch, the T3 tools) pass. */
export function checkTool(tool: unknown, input: Record<string, unknown> | undefined): Verdict {
	const i = input ?? {};
	if (typeof tool !== "string") return no("no tool name");
	if (WRITE_TOOLS.has(tool)) return no(`${tool}: the desk fixes nothing, so it writes nothing`);
	if (tool === "Bash") return checkCommand(i.command);
	if (tool === "Read") return checkPath(i.file_path);
	if (tool === "Grep") return checkPath(i.path);
	if (tool === "Glob") {
		// A glob pattern that is itself absolute, or climbs, would leave the directory the path check approved.
		if (typeof i.pattern === "string" && (i.pattern.startsWith("/") || i.pattern.split("/").includes(".."))) return no("a glob pattern must stay inside the directory it is given");
		return checkPath(i.path);
	}
	return ok;
}

if (import.meta.main) {
	const [mode, arg] = process.argv.slice(2);
	if (mode === "check") {
		const v = checkCommand(arg);
		console.log(v.ok ? "allow" : `refuse: ${v.reason}`);
		process.exit(v.ok ? 0 : 2);
	}
	if (mode === "hook") {
		let v: Verdict;
		try {
			const j = JSON.parse(await Bun.stdin.text()) as { tool_name?: unknown; tool_input?: Record<string, unknown> };
			v = checkTool(j.tool_name, j.tool_input);
		} catch { v = no("the hook input was not JSON"); }
		if (!v.ok) console.error(`alert desk allowlist: refused. ${v.reason}`);
		process.exit(v.ok ? 0 : 2);
	}
	console.error("usage: bun src/desk-allowlist.ts hook | check '<command>'");
	process.exit(64);
}
