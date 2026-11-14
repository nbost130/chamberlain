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
import { type DeskOperator, deskAskCommand, morningPattern, readOperator } from "./core/alert-desk-prompt.ts";
import { CONF, selfCommand } from "./core/config.ts";
import type { Shape, ShapeBody, ShapeSet, ValueKind } from "./core/desk-shapes.ts";
import { checkSimple, verdictOf } from "./desk-checks.ts";
import { DIGITS, type Flag, parse, REF, REPO, type Spec, TIME, UNIT, WORD } from "./desk-parse.ts";
import { tokenize } from "./desk-tokenize.ts";

export type Verdict = { ok: true } | { ok: false; reason: string };
export const ok: Verdict = { ok: true };
export const no = (reason: string): Verdict => ({ ok: false, reason });

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

/** The subcommand of `subs` that `args` begins with (a longer name wins over a shorter one), with its body, or undefined when none does. */
function subcommandOf(subs: Record<string, ShapeBody>, args: string[]): { sub: string; body: ShapeBody } | undefined {
	const longestFirst = Object.entries(subs).sort(([x], [y]) => y.split(" ").length - x.split(" ").length);
	const found = longestFirst.find(([k]) => k.split(" ").every((w, i) => args[i] === w));
	return found && { sub: found[0], body: found[1] };
}

/** The refusal for a subcommand that is not one of the shape's. */
function noSuchSubcommand(name: string, subs: string[], bare: boolean | undefined): Verdict {
	return no(`${name}: only ${subs.map((k) => `\`${k}\``).join(", ")} ${bare ? "(or nothing) " : ""}are allowed`);
}

const SAFE_PATH = /^[A-Za-z0-9._/-]{1,200}$/;
const unsafePath = (p: string) => !SAFE_PATH.test(p) || p.startsWith("/") || p.split("/").includes("..");

/** A command that is a data shape (gh, git, and the operator's own): its subcommand is one of the shape's, and the rest fits that subcommand's body. */
export function checkShape(name: string, args: string[], shape: Shape): Verdict {
	let body: ShapeBody = shape,
		rest = args,
		what = name;
	if (shape.subcommands) {
		if (args.length === 0 && shape.bare) return ok;
		const found = subcommandOf(shape.subcommands, args);
		if (found === undefined) return noSuchSubcommand(name, Object.keys(shape.subcommands), shape.bare);
		body = found.body;
		rest = args.slice(found.sub.split(" ").length);
		what = `${name} ${found.sub}`;
	}
	if (body.paths) {
		// A `--` ends the flags; what follows is relative paths inside the checkout, never `..` or an absolute path.
		const dd = rest.indexOf("--");
		const paths = dd < 0 ? [] : rest.slice(dd + 1);
		if (dd >= 0) rest = rest.slice(0, dd);
		if (paths.some(unsafePath)) return no(`${what}: a path after -- must be relative, inside the repo`);
	}
	return verdictOf(parse(rest, specOf(body), what));
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
	if (first === undefined) return no("an empty command around a pipe");
	const pipeFault = pipeRefusal(pipes);
	if (pipeFault !== undefined) return no(pipeFault);
	return checkSimple(first, o.shapes ?? operator().shapes);
}

/** Why the pipes after the command are refused, or undefined when there are none or the one is a final `head -n N`, `tail -n N` or `wc -l`. */
function pipeRefusal(pipes: string[][]): string | undefined {
	if (pipes.length > 1) return "at most one pipe, into head, tail or wc";
	const pipe = pipes[0];
	if (pipe === undefined) return undefined;
	const [p, ...a] = pipe;
	const tail = a.join(" ");
	const allowed = ((p === "head" || p === "tail") && /^-n \d{1,5}$/.test(tail)) || (p === "wc" && tail === "-l");
	return allowed ? undefined : "a pipe may only go into `head -n N`, `tail -n N` or `wc -l`";
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
			return checkGlob(i);
		case "Agent":
		case "Task":
			return checkAgent(tool, i, o);
		default:
			return no(
				`${tool} is not an allowed tool: the desk reads, starts its gatherer agent and files decisions, and does nothing else`,
			);
	}
}

/** A glob pattern that is itself absolute, or climbs, would leave the directory the path check approved. */
function checkGlob(i: Record<string, unknown>): Verdict {
	if (typeof i.pattern === "string" && (i.pattern.startsWith("/") || i.pattern.split("/").includes("..")))
		return no("a glob pattern must stay inside the directory it is given");
	return checkPath(i.path);
}

/** The Agent (or Task) tool: allowed only to start the operator's gatherer, with only the fields a plain gatherer needs. */
function checkAgent(tool: string, i: Record<string, unknown>, o: { gatherer?: string }): Verdict {
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
