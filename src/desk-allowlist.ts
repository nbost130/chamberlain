/**
 * The Alert Desk's command allowlist, enforced in code: a Claude Code PreToolUse hook for the desk thread's project (and so for the
 * gatherer agents it starts). The standing prompt (docs/alert-desk-prompt.md) tells the desk what it may run; this is what refuses
 * the rest, so a gatherer that has been talked into something by an alert's text still cannot do it.
 *
 *   bun src/desk-allowlist.ts hook            reads the hook's JSON on stdin; exit 2 with the reason on stderr refuses the call
 *   bun src/desk-allowlist.ts check '<cmd>'   one command by hand: prints allow or the reason, exit 0 or 2
 *
 * The rule is a FIXED SET OF COMMAND SHAPES, not a list of dangerous things. A command is one simple command, tokenized here with the quoting
 * rules a POSIX shell applies to the subset accepted (no expansion, substitution, redirection, chaining or globbing outside quotes, and none of
 * `$`, a backtick or a backslash inside them), whose name has a shape (journalctl, systemctl and docker in code; gh, git and the operator's own as data, `src/core/desk-shapes.ts`) and whose every flag is one that shape lists. The one pipe allowed is a
 * final `head -n N`, `tail -n N` or `wc -l`. Anything else is refused with the first thing wrong.
 *
 * File reads (the Read, Grep and Glob tools) are allowed only under LOG_DIRS, after `..` and symlinks are resolved, and never for a path with a
 * component that names a credential (.env, keys, tokens, ssh, gnupg, aws, passage...). The desk fixes nothing, so the write tools are refused.
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type DeskOperator, deskAskCommand, morningPattern, readOperator } from "./core/alert-desk.ts";
import { CONF, selfCommand } from "./core/config.ts";
import { GENERIC_SHAPES, type Shape, type ShapeBody, type ShapeSet, type ValueKind } from "./core/desk-shapes.ts";

export type Verdict = { ok: true } | { ok: false; reason: string };
const ok: Verdict = { ok: true };
const no = (reason: string): Verdict => ({ ok: false, reason });

const HOME = process.env.HOME ?? "";
/** The only places a file may be read from. */
/** Colon-separated extra directories in DESK_LOG_DIRS. */
export const LOG_DIRS = [
	"/var/log",
	`${HOME}/.cache/alert-desk`,
	...(process.env.DESK_LOG_DIRS ?? "").split(":").filter(Boolean),
];
/** A path component that names a credential: refused even inside a log directory. */
const SECRET_NAME =
	/^(\.env(\..*)?|.*\.(pem|key|p12|pfx|kdbx|age)|id_(rsa|ed25519|ecdsa|dsa)(\.pub)?|\.?credentials?(\..*)?|\.?secrets?(\..*)?|\.netrc|\.npmrc|\.git-credentials|.*token.*|.*passw(or)?d.*|.*\.secret|\.ssh|\.gnupg|\.aws|\.password-store|passage|read-token)$/i;

// ---- tokenizing --------------------------------------------------------------------------------------

type Lex = {
	/** The commands so far, split at each unquoted `|`; `part` is the last of them. */
	parts: string[][];
	part: string[];
	cur: string;
	inTok: boolean;
	q: "" | "'" | '"';
};

/** Ends the token being read, if one has begun. */
function endToken(s: Lex): void {
	if (s.inTok) s.part.push(s.cur);
	s.cur = "";
	s.inTok = false;
}

/** One character inside quotes: the fault, or undefined once it is taken. Nothing expands in single quotes; in double quotes `$`, a backtick and a backslash do. */
function quotedChar(s: Lex, c: string): string | undefined {
	if (s.q === "'") {
		if (c === "'") s.q = "";
		else s.cur += c;
		return undefined;
	}
	if (c === '"') s.q = "";
	else if (c === "$" || c === "`" || c === "\\") return "a $, backtick or backslash inside double quotes expands";
	else s.cur += c;
	return undefined;
}

const SHELL_SYNTAX = /[;&<>(){}$`\\*?[\]!~#\n\r]/;

/** One character outside quotes, with the one after it: the fault, or undefined once it is taken. */
function bareChar(s: Lex, c: string, next: string | undefined): string | undefined {
	if (c === "'" || c === '"') {
		s.q = c;
		s.inTok = true;
	} else if (c === " " || c === "\t") {
		endToken(s);
	} else if (c === "|") {
		if (next === "|") return "|| chains commands";
		endToken(s);
		s.part = [];
		s.parts.push(s.part);
	} else if (SHELL_SYNTAX.test(c)) {
		return `an unquoted ${JSON.stringify(c)} is shell syntax (chaining, redirection, expansion or a glob)`;
	} else {
		s.cur += c;
		s.inTok = true;
	}
	return undefined;
}

/** Splits on unquoted `|` and tokenizes each part, or says what is wrong. Quoted text is literal; an unquoted metacharacter is refused. */
function tokenize(cmd: string): { parts: string[][] } | { error: string } {
	const first: string[] = [];
	const s: Lex = { parts: [first], part: first, cur: "", inTok: false, q: "" };
	for (let i = 0; i < cmd.length; i++) {
		const c = cmd.charAt(i);
		const fault = s.q ? quotedChar(s, c) : bareChar(s, c, cmd[i + 1]);
		if (fault !== undefined) return { error: fault };
	}
	if (s.q) return { error: "an unclosed quote" };
	endToken(s);
	if (s.parts.some((p) => p.length === 0)) return { error: "an empty command around a pipe" };
	return { parts: s.parts };
}

// ---- flag specs --------------------------------------------------------------------------------------

type Flag = "bool" | RegExp | ((value: string) => boolean);
type Spec = {
	/** Every flag the command may take, under every spelling it may be written with. Anything else is refused. */
	flags: Record<string, Flag>;
	/** Other spellings of one flag (`--format` is `-f`): a flag may be given ONCE, under any of its spellings. */
	same?: Record<string, string>;
	/** Positional arguments: each must match, at most `max`. */
	positional?: RegExp;
	max?: number;
	min?: number;
};
type Parsed = {
	pos: string[] /** Each flag given, by its first spelling, with its value (`true` for a flag with none). */;
	flag: Record<string, string | true>;
};
const DIGITS = /^\d{1,6}$/;
const TIME = /^[\w:. +-]{1,40}$/;
const UNIT = /^[A-Za-z0-9@_.:-]{1,100}$/;
const WORD = /^[A-Za-z0-9_.@:-]{1,64}$/;
const REPO = /^[\w.-]{1,60}\/[\w.-]{1,100}$/;
const REF = /^[A-Za-z0-9._/@~^{}-]{1,100}$/;

/**
 * Parses the WHOLE argument list against a spec, never one flag at a time: a flag that is not in the spec is refused, a flag given twice (in any
 * spelling, `-f` then `--format=`) is refused, and the value of every flag given is checked. Returns what was given, or the first fault.
 */
function parse(args: string[], spec: Spec, what: string): Parsed | Verdict {
	const pos: string[] = [];
	const flag: Record<string, string | true> = {};
	const rest = [...args];
	for (let a = rest.shift(); a !== undefined; a = rest.shift()) {
		if (!a.startsWith("-")) {
			if (!spec.positional?.test(a))
				return no(`${what}: the argument ${JSON.stringify(a.slice(0, 40))} is not allowed`);
			pos.push(a);
			continue;
		}
		const fault = takeFlag(a, rest, spec, what, flag);
		if (fault) return fault;
	}
	if (spec.max !== undefined && pos.length > spec.max) return no(`${what}: too many arguments`);
	if (spec.min !== undefined && pos.length < spec.min) return no(`${what}: missing an argument`);
	return { pos, flag };
}

/** One flag argument `a`, recorded in `flag`: a value written `--name=value` comes with it, any other is taken from the front of `rest`. Returns the fault, if any. */
function takeFlag(
	a: string,
	rest: string[],
	spec: Spec,
	what: string,
	flag: Record<string, string | true>,
): Verdict | undefined {
	const eq = a.startsWith("--") ? a.indexOf("=") : -1;
	const name = eq > 0 ? a.slice(0, eq) : a;
	const rule = spec.flags[name];
	if (rule === undefined) return no(`${what}: the flag ${name} is not on the allowlist`);
	const key = spec.same?.[name] ?? name;
	if (key in flag) return no(`${what}: the flag ${key} is given more than once`);
	if (rule === "bool") {
		if (eq > 0) return no(`${what}: ${name} takes no value`);
		flag[key] = true;
		return undefined;
	}
	const value = eq > 0 ? a.slice(eq + 1) : rest.shift();
	if (value === undefined || !(typeof rule === "function" ? rule(value) : rule.test(value)))
		return no(`${what}: the value of ${name} is not allowed`);
	flag[key] = value;
	return undefined;
}
const isVerdict = (x: Parsed | Verdict): x is Verdict => "ok" in x;

/** `docker inspect --format` and `docker ps --format`: literal text and `{{.Field}}` for these fields only. No `json`, no `range`, no object that holds the environment. */
const INSPECT_FIELDS = [
	"Name",
	"RestartCount",
	"State.Status",
	"State.Running",
	"State.Restarting",
	"State.OOMKilled",
	"State.ExitCode",
	"State.StartedAt",
	"State.FinishedAt",
	"State.Health.Status",
	"Config.Image",
	"HostConfig.RestartPolicy.Name",
	"Created",
];
const PS_FIELDS = ["Names", "Status", "State", "Image", "RunningFor", "ID", "CreatedAt", "Ports"];
const formatOk = (fmt: string, fields: string[]) =>
	new RegExp(`^(?:[^{}$\`\\\\]|\\{\\{\\.(?:${fields.map((f) => f.replace(/\./g, "\\.")).join("|")})\\}\\})*$`).test(
		fmt,
	) && fmt.length <= 300;
const inspectFormat = (v: string) => formatOk(v, INSPECT_FIELDS);
const psFormat = (v: string) => formatOk(v, PS_FIELDS);

// ---- the command shapes ------------------------------------------------------------------------------

/** A journald priority, a name or 0-7, or a range of two (`warning..emerg`). Anything else journalctl would refuse, so it is refused here. */
const PRIO = "(?:emerg|alert|crit|err|warning|notice|info|debug|[0-7])";
const PRIORITY = new RegExp(`^${PRIO}(?:\\.\\.${PRIO})?$`);
const OUTPUT = /^(short|short-iso|short-precise|cat)$/;
const journalctl: Spec = {
	flags: {
		"--user": "bool",
		"--no-pager": "bool",
		"-r": "bool",
		"--reverse": "bool",
		"-u": UNIT,
		"--unit": UNIT,
		"-n": DIGITS,
		"--lines": DIGITS,
		"--since": TIME,
		"--until": TIME,
		"-p": PRIORITY,
		"--priority": PRIORITY,
		"-o": OUTPUT,
		"--output": OUTPUT,
	},
	same: { "--reverse": "-r", "--unit": "-u", "--lines": "-n", "--priority": "-p", "--output": "-o" },
};
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;

function checkSimple(tokens: string[], shapes: ShapeSet): Verdict {
	const [name, ...args] = tokens;
	if (!name || name.includes("/") || name.includes("="))
		return no("the command must be a bare name from the allowlist");
	switch (name) {
		case "journalctl": {
			const r = parse(args, journalctl, "journalctl");
			return isVerdict(r) ? r : ok;
		}
		case "systemctl": {
			const r = parse(
				args,
				{
					flags: {
						"--user": "bool",
						"--no-pager": "bool",
						"-l": "bool",
						"--full": "bool",
						"-n": DIGITS,
						"--lines": DIGITS,
						"--failed": "bool",
					},
					same: { "--full": "-l", "--lines": "-n" },
					positional: UNIT,
				},
				"systemctl",
			);
			if (isVerdict(r)) return r;
			const [sub, ...units] = r.pos;
			if (!sub || !["status", "is-active", "is-failed", "list-units"].includes(sub))
				return no(
					`systemctl: only status, is-active, is-failed and list-units are allowed (not ${JSON.stringify(sub ?? "")}); cat and show print unit files and environments`,
				);
			if (sub === "list-units" && units.length) return no("systemctl list-units takes no unit");
			if (sub !== "list-units" && units.length === 0) return no(`systemctl ${sub} needs a unit`);
			return ok;
		}
		case "docker": {
			const [sub, ...rest] = args;
			if (sub === "ps") {
				const r = parse(
					rest,
					{
						flags: { "-a": "bool", "--all": "bool", "--no-trunc": "bool", "--format": psFormat },
						same: { "--all": "-a" },
						max: 0,
					},
					"docker ps",
				);
				return isVerdict(r) ? r : ok;
			}
			if (sub === "logs") {
				const r = parse(
					rest,
					{
						flags: { "--tail": DIGITS, "--since": TIME, "--until": TIME, "-t": "bool", "--timestamps": "bool" },
						same: { "--timestamps": "-t" },
						positional: CONTAINER,
						max: 1,
						min: 1,
					},
					"docker logs",
				);
				return isVerdict(r) ? r : ok;
			}
			if (sub === "inspect") {
				// One --format, in one spelling, and it is checked as it is parsed: `--format A --format B` and `-f A --format=B` are both refused.
				const r = parse(
					rest,
					{
						flags: { "--format": inspectFormat, "-f": inspectFormat },
						same: { "--format": "-f" },
						positional: CONTAINER,
						min: 1,
						max: 6,
					},
					"docker inspect",
				);
				if (isVerdict(r)) return r;
				return "-f" in r.flag
					? ok
					: no("docker inspect: a --format is required, because the full document holds the container's environment");
			}
			return no("docker: only ps, logs and inspect are allowed");
		}
		default: {
			const shape = GENERIC_SHAPES[name] ?? shapes[name];
			return shape ? checkShape(name, args, shape) : no(`${JSON.stringify(name.slice(0, 40))} is not on the allowlist`);
		}
	}
}

const KINDS: Record<ValueKind, RegExp> = { digits: DIGITS, word: WORD, unit: UNIT, time: TIME, repo: REPO, ref: REF };

/** Compiles one command's (or subcommand's) data shape into the spec `parse` applies. */
function specOf(b: ShapeBody): Spec {
	const flags: Record<string, Flag> = {};
	for (const [k, v] of Object.entries(b.flags ?? {})) flags[k] = v === "bool" ? "bool" : KINDS[v];
	const positional =
		b.positional === undefined
			? undefined
			: Array.isArray(b.positional)
				? new RegExp(`^(?:${b.positional.map(escRe).join("|")})$`)
				: KINDS[b.positional];
	// A shape that lists no positional takes none; one that does takes up to its `max` (unbounded if unset).
	return {
		flags,
		...(b.same ? { same: b.same } : {}),
		...(positional ? { positional } : {}),
		...(b.max !== undefined ? { max: b.max } : positional ? {} : { max: 0 }),
		...(b.min !== undefined ? { min: b.min } : {}),
	};
}

/** A command that is a data shape (gh, git, and the operator's own): its subcommand is one of the shape's, and the rest fits that subcommand's body. */
function checkShape(name: string, args: string[], shape: Shape): Verdict {
	let body: ShapeBody = shape,
		rest = args,
		what = name;
	if (shape.subcommands) {
		if (args.length === 0 && shape.bare) return ok;
		const sub = Object.keys(shape.subcommands)
			.sort((x, y) => y.split(" ").length - x.split(" ").length)
			.find((k) => k.split(" ").every((w, i) => args[i] === w));
		if (sub === undefined)
			return no(
				`${name}: only ${Object.keys(shape.subcommands)
					.map((k) => `\`${k}\``)
					.join(", ")} ${shape.bare ? "(or nothing) " : ""}are allowed`,
			);
		body = shape.subcommands[sub]!;
		rest = args.slice(sub.split(" ").length);
		what = `${name} ${sub}`;
	}
	if (body.paths) {
		// A `--` ends the flags; what follows is relative paths inside the checkout, never `..` or an absolute path.
		const dd = rest.indexOf("--");
		const paths = dd < 0 ? [] : rest.slice(dd + 1);
		if (dd >= 0) rest = rest.slice(0, dd);
		if (paths.some((p) => !/^[A-Za-z0-9._/-]{1,200}$/.test(p) || p.startsWith("/") || p.split("/").includes("..")))
			return no(`${what}: a path after -- must be relative, inside the repo`);
	}
	const r = parse(rest, specOf(body), what);
	return isVerdict(r) ? r : ok;
}

/**
 * The few commands that are not simple flag shapes, matched whole: the decision queue, and the operator's own morning sources
 * (`morningCommands` in alert-desk.json, each exactly as written with `<N>` for a number, `<N:a-b>` for one of a to b digits). The operator's
 * `commandShapes` and `gatherer` come from the same file. All three are read only from a file the operator owns that no one else can write
 * (`readOperator`). Nothing private is built in: with none configured, only the generic shapes above are allowed.
 */
/** The one command the desk may run to file a decision (DESK_ASK_PATH, else this build's own): the same command the standing prompt is filled with. */
const askCommand = () => deskAskCommand();
/** Does a morning command have a `<N>` or `<N:a-b>` slot? Without one it is matched as the exact string. */
const hasSlot = (m: string) => /<N(?::[^>]*)?>/.test(m);
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
let configured: DeskOperator | undefined;
/** What the operator configured, read once per process (the hook is one process per call). */
const operator = () => (configured ??= readOperator(CONF, (m) => console.error(m)));

/** Is this one shell command allowed? `o` is a seam for tests: the morning commands and command shapes, instead of alert-desk.json's. */
export function checkCommand(cmd: unknown, o: { morning?: readonly string[]; shapes?: ShapeSet } = {}): Verdict {
	if (typeof cmd !== "string" || !cmd.trim()) return no("no command");
	// Never trimmed or normalised: the command is matched as it was sent. Surrounding whitespace of any kind (a space, a tab, a newline, a
	// no-break space, a byte-order mark) is not part of any allowed shape, so it is refused, as the predecessor's exact match refused it.
	const c = cmd;
	if (c.length > 9000) return no("the command is too long");
	if (new RegExp(`^${escRe(askCommand())} '[^']{1,8000}'$`).test(c)) return ok;
	// A morning command with no `<N>` slot is the exact string; one with a slot is its anchored full-string pattern, on the same untrimmed input.
	if ((o.morning ?? operator().morning.commands).some((m) => (hasSlot(m) ? morningPattern(m).test(c) : m === c)))
		return ok;
	const t = tokenize(c);
	if ("error" in t) return no(t.error);
	const [first, ...pipes] = t.parts;
	if (pipes.length > 1) return no("at most one pipe, into head, tail or wc");
	if (pipes.length === 1) {
		const [p, ...a] = pipes[0]!;
		const tail = a.join(" ");
		if (!((p === "head" || p === "tail") && /^-n \d{1,5}$/.test(tail)) && !(p === "wc" && tail === "-l"))
			return no("a pipe may only go into `head -n N`, `tail -n N` or `wc -l`");
	}
	return checkSimple(first!, o.shapes ?? operator().shapes);
}

// ---- file reads --------------------------------------------------------------------------------------

/** Resolves `..` and symlinks (of the path, or of its nearest existing parent). */
function real(p: string): string {
	let cur = resolve(p),
		tail = "";
	while (!existsSync(cur) && dirname(cur) !== cur) {
		tail = `${cur.slice(dirname(cur).length)}${tail}`;
		cur = dirname(cur);
	}
	try {
		return realpathSync(cur) + tail;
	} catch {
		return resolve(p);
	}
}
const logDirs = () =>
	LOG_DIRS.map((d) => {
		try {
			return realpathSync(d);
		} catch {
			return resolve(d);
		}
	});

/** May this path be read? Absolute, under a log directory once resolved, and with no component that names a credential. */
export function checkPath(p: unknown): Verdict {
	if (typeof p !== "string" || !p.startsWith("/")) return no("a read needs an absolute path");
	const r = real(p);
	if (!logDirs().some((d) => r === d || r.startsWith(`${d}/`)))
		return no(`${p} is not under a log directory (${LOG_DIRS.join(", ")})`);
	const bad = r.split("/").find((seg) => seg && SECRET_NAME.test(seg));
	return bad ? no(`${p} has a component (${bad}) that names a credential`) : ok;
}

/**
 * The hook's decision for one tool call, and it DENIES BY DEFAULT: Bash (in the fixed shapes), Read, Grep and Glob (under the log directories),
 * and the Agent tool only to start the operator's `gatherer` agent (`gatherer` in alert-desk.json), which is how the desk fans out; with none
 * configured the Agent tool is refused too. Every other tool is refused, MCP tools and the write tools included, and so is a call with no tool
 * name. The settings matcher must therefore cover every tool (see docs/alert-desk.md). `o.gatherer` is a seam for tests.
 */
const GATHERER_FIELDS = new Set(["subagent_type", "description", "prompt", "run_in_background"]);
export function checkTool(
	tool: unknown,
	input: Record<string, unknown> | undefined,
	o: { gatherer?: string } = {},
): Verdict {
	const i = input ?? {};
	if (typeof tool !== "string" || !tool) return no("no tool name");
	switch (tool) {
		case "Bash":
			return checkCommand(i.command);
		case "Read":
			return checkPath(i.file_path);
		case "Grep":
			return checkPath(i.path);
		case "Glob":
			// A glob pattern that is itself absolute, or climbs, would leave the directory the path check approved.
			if (typeof i.pattern === "string" && (i.pattern.startsWith("/") || i.pattern.split("/").includes("..")))
				return no("a glob pattern must stay inside the directory it is given");
			return checkPath(i.path);
		case "Agent":
		case "Task": {
			const gatherer = "gatherer" in o ? o.gatherer : operator().gatherer;
			if (!gatherer)
				return no(
					`${tool}: no gatherer agent is configured (\`gatherer\` in alert-desk.json), so the desk starts no agent`,
				);
			if (i.subagent_type !== gatherer) return no(`${tool}: the desk may start only a ${gatherer} gatherer`);
			// Only the fields a plain gatherer needs. Anything else (isolation, a model, a name, a working directory, a team) is refused, so the
			// exception cannot be widened into a checkout, a stronger model or a remote run.
			const extra = Object.keys(i).find((k) => !GATHERER_FIELDS.has(k));
			if (extra !== undefined)
				return no(
					`${tool}: the field ${JSON.stringify(extra.slice(0, 40))} is not allowed when starting a ${gatherer} gatherer`,
				);
			if (typeof i.prompt !== "string" || (i.description !== undefined && typeof i.description !== "string"))
				return no(`${tool}: a ${gatherer} gatherer needs a text prompt`);
			if (i.run_in_background !== undefined && typeof i.run_in_background !== "boolean")
				return no(`${tool}: run_in_background must be true or false`);
			return ok;
		}
		default:
			return no(
				`${tool} is not an allowed tool: the desk reads, starts its gatherer agent and files decisions, and does nothing else`,
			);
	}
}

export async function main(argv: string[] = process.argv.slice(2)) {
	const [mode, arg] = argv;
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
		} catch {
			v = no("the hook input was not JSON");
		}
		if (!v.ok) console.error(`alert desk allowlist: refused. ${v.reason}`);
		process.exit(v.ok ? 0 : 2);
	}
	console.error(`usage: ${selfCommand("desk-allowlist")} hook | check '<command>'`);
	process.exit(64);
}

if (import.meta.main) await main();
