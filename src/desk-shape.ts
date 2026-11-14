/** The Alert Desk's command allowlist: checking a command's arguments against its shape. */
import type { Shape, ShapeBody, ValueKind } from "./core/desk-shapes.ts";
import { DIGITS, escRe, type Flag, parse, REF, REPO, type Spec, TIME, UNIT, verdictOf, WORD } from "./desk-parse.ts";
import { no, ok, type Verdict } from "./desk-verdict.ts";

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
