/**
 * The Alert Desk's command shapes as data. A shape says which arguments one command may take: its subcommands, its flags (each with the kind
 * of value it accepts), its positional arguments and how many. src/desk-allowlist.ts compiles a shape into the check it applies to a command.
 *
 * Two sources use this one format:
 *   - the generic shapes that ship with Chamberlain (`GENERIC_SHAPES`: gh and git, read commands only), and
 *   - the operator's own, `commandShapes` in alert-desk.json, for a wrapper or tool only that install has. Nothing private is built in.
 *
 * Pure: no files, no environment.
 */

/** What a flag value or a positional argument may be. Each is a fixed, anchored pattern in src/desk-allowlist.ts; none is free text. */
export const VALUE_KINDS = ["digits", "word", "unit", "time", "repo", "ref"] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

/** One command (or one subcommand) of a shape. */
export type ShapeBody = {
	/** Flags it may take, under every spelling: `bool` for a flag with no value, else the kind of value. */
	flags?: Record<string, "bool" | ValueKind>;
	/** Other spellings of one flag (`--max-count` is `-n`): a flag may be given once, under any of its spellings. */
	same?: Record<string, string>;
	/** Positional arguments: a kind of value, or the literal words allowed. */
	positional?: ValueKind | string[];
	min?: number;
	max?: number;
	/** `--` may end the flags, and what follows is relative paths inside the checkout (never `..` or an absolute path). */
	paths?: boolean;
};
export type Shape = ShapeBody & {
	/** The command with no argument at all is allowed (only meaningful with `subcommands`). */
	bare?: boolean;
	/** One or two words each (`run view`): the command must start with one of them, and the rest is checked against that subcommand's body. */
	subcommands?: Record<string, ShapeBody>;
};
export type ShapeSet = Record<string, Shape>;

/** gh and git, read commands only. The same shapes an operator's wrapper would declare. */
export const GENERIC_SHAPES: ShapeSet = {
	gh: {
		subcommands: {
			"run view": { flags: { "--repo": "repo", "--log-failed": "bool" }, positional: "digits", min: 1, max: 1 },
			"run list": { flags: { "--repo": "repo", "--limit": "digits" }, max: 0 },
			"pr checks": { flags: { "--repo": "repo" }, positional: "digits", min: 1, max: 1 },
		},
	},
	git: {
		subcommands: {
			status: { paths: true, max: 0 },
			log: gitRead(),
			diff: gitRead(),
		},
	},
};
function gitRead(): ShapeBody {
	return {
		flags: { "--stat": "bool", "--shortstat": "bool", "--name-only": "bool", "--name-status": "bool", "--oneline": "bool", "--no-color": "bool", "-n": "digits", "--max-count": "digits", "--since": "time", "--until": "time" },
		same: { "--max-count": "-n" },
		positional: "ref",
		max: 4,
		paths: true,
	};
}

/** Commands whose shapes are code (their values need more than a pattern): an operator may not redefine them. */
export const BUILT_IN_COMMANDS = ["journalctl", "systemctl", "docker", ...Object.keys(GENERIC_SHAPES)];

const COMMAND = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$/;
const FLAG = /^--?[A-Za-z][A-Za-z0-9-]{0,40}$/;
const SUBCOMMAND = /^[a-z][a-z0-9-]{0,30}( [a-z][a-z0-9-]{0,30})?$/;
const LITERAL = /^[A-Za-z0-9_.-]{1,40}$/;
const isKind = (x: unknown): x is ValueKind => typeof x === "string" && (VALUE_KINDS as readonly string[]).includes(x);
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const count = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 20;

/** Pure: why a shape body is malformed, or its normalized form. */
function parseBody(raw: unknown, withSubcommands: boolean): ShapeBody | string {
	if (!isObj(raw)) return "is not an object";
	const known = new Set(["flags", "same", "positional", "min", "max", "paths", ...(withSubcommands ? ["bare", "subcommands"] : [])]);
	const stray = Object.keys(raw).find((k) => !known.has(k));
	if (stray !== undefined) return `has an unknown field ${JSON.stringify(stray.slice(0, 40))}`;
	const out: ShapeBody = {};
	if (raw.flags !== undefined) {
		if (!isObj(raw.flags)) return "has `flags` that is not an object";
		const flags: Record<string, "bool" | ValueKind> = {};
		for (const [k, v] of Object.entries(raw.flags)) {
			if (!FLAG.test(k)) return `has the flag ${JSON.stringify(k.slice(0, 40))}, which is not written -x or --name`;
			if (v !== "bool" && !isKind(v)) return `has the flag ${k} with a value kind that is not bool, ${VALUE_KINDS.join(", ")}`;
			flags[k] = v;
		}
		out.flags = flags;
	}
	if (raw.same !== undefined) {
		if (!isObj(raw.same)) return "has `same` that is not an object";
		const same: Record<string, string> = {};
		for (const [k, v] of Object.entries(raw.same)) {
			if (typeof v !== "string" || !FLAG.test(k) || !out.flags || !(k in out.flags) || !(v in out.flags)) return `has a \`same\` entry (${JSON.stringify(k.slice(0, 40))}) that does not join two flags it lists`;
			same[k] = v;
		}
		out.same = same;
	}
	if (raw.positional !== undefined) {
		if (isKind(raw.positional)) out.positional = raw.positional;
		else if (Array.isArray(raw.positional) && raw.positional.length > 0 && raw.positional.length <= 20 && raw.positional.every((w) => typeof w === "string" && LITERAL.test(w))) out.positional = raw.positional as string[];
		else return `has a \`positional\` that is neither a kind (${VALUE_KINDS.join(", ")}) nor a list of plain words`;
	}
	for (const k of ["min", "max"] as const) {
		if (raw[k] === undefined) continue;
		if (!count(raw[k])) return `has a \`${k}\` that is not a whole number from 0 to 20`;
		out[k] = raw[k] as number;
	}
	if (raw.paths !== undefined) {
		if (typeof raw.paths !== "boolean") return "has `paths` that is not true or false";
		if (raw.paths) out.paths = true;
	}
	return out;
}

/**
 * Pure: the operator's shapes from a parsed alert-desk.json `commandShapes`. A command or subcommand that is malformed, or that names a
 * built-in command, is left out whole, and `warn` says which and why: a shape is never half-applied.
 */
export function parseShapes(raw: unknown, warn: (msg: string) => void = () => {}): ShapeSet {
	if (raw === undefined) return {};
	if (!isObj(raw)) { warn("alert desk: ignoring commandShapes: it is not an object"); return {}; }
	const out: ShapeSet = {};
	for (const [name, def] of Object.entries(raw)) {
		const drop = (why: string) => warn(`alert desk: ignoring the command shape ${JSON.stringify(name.slice(0, 60))}: ${why}`);
		if (!COMMAND.test(name)) { drop("a command is a bare name"); continue; }
		if (BUILT_IN_COMMANDS.includes(name)) { drop("it is a built-in command, whose shape cannot be changed"); continue; }
		const top = parseBody(def, true);
		if (typeof top === "string") { drop(top); continue; }
		const shape: Shape = { ...top };
		const d = def as Record<string, unknown>;
		if (d.bare !== undefined) {
			if (typeof d.bare !== "boolean") { drop("has `bare` that is not true or false"); continue; }
			if (d.bare) shape.bare = true;
		}
		if (d.subcommands !== undefined) {
			if (!isObj(d.subcommands)) { drop("has `subcommands` that is not an object"); continue; }
			const subs: Record<string, ShapeBody> = {};
			let bad: string | undefined;
			for (const [sub, body] of Object.entries(d.subcommands)) {
				if (!SUBCOMMAND.test(sub)) { bad = `the subcommand ${JSON.stringify(sub.slice(0, 40))} is not one or two lowercase words`; break; }
				const b = parseBody(body, false);
				if (typeof b === "string") { bad = `the subcommand ${JSON.stringify(sub)} ${b}`; break; }
				subs[sub] = b;
			}
			if (bad) { drop(bad); continue; }
			shape.subcommands = subs;
		}
		out[name] = shape;
	}
	return out;
}

/** Pure: a gatherer agent name from a parsed alert-desk.json, or undefined (and a warning) when it is not a plain name. */
export function parseGatherer(raw: unknown, warn: (msg: string) => void = () => {}): string | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$/.test(raw)) return raw;
	warn("alert desk: ignoring `gatherer`: it is a plain agent name (letters, digits, `_`, `.`, `-`)");
	return undefined;
}

/** Pure: one line of the standing prompt for each thing a shape allows, so the prompt teaches exactly what the hook accepts. */
export function describeShape(name: string, shape: Shape): string[] {
	const arg = (b: ShapeBody) => {
		const flags = Object.entries(b.flags ?? {}).filter(([k]) => !(b.same && k in b.same)).map(([k, v]) => (v === "bool" ? `[${k}]` : `[${k} <${v}>]`));
		const one = b.positional === undefined ? "" : Array.isArray(b.positional) ? b.positional.join("|") : `<${b.positional}>`;
		const pos = b.positional === undefined ? [] : [(b.min ?? 0) > 0 && !Array.isArray(b.positional) ? one : `[${one}]`];
		return [...flags, ...pos, ...(b.paths ? ["[-- <relative path>]"] : [])].join(" ");
	};
	const lines: string[] = [];
	if (shape.bare) lines.push(`\`${name}\``);
	if (shape.subcommands) for (const [sub, body] of Object.entries(shape.subcommands)) lines.push(`\`${`${name} ${sub} ${arg(body)}`.trim()}\``);
	else lines.push(`\`${`${name} ${arg(shape)}`.trim()}\``);
	return lines;
}
