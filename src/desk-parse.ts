/** The Alert Desk's command allowlist: parsing a command's flags and arguments against its spec. */
import { no, type Verdict } from "./desk-verdict.ts";

export type Flag = "bool" | RegExp | ((value: string) => boolean);
export type Spec = {
	/** Every flag the command may take, under every spelling it may be written with. Anything else is refused. */
	flags: Record<string, Flag>;
	/** Other spellings of one flag (`--format` is `-f`): a flag may be given ONCE, under any of its spellings. */
	same?: Record<string, string>;
	/** Positional arguments: each must match, at most `max`. */
	positional?: RegExp;
	max?: number;
	min?: number;
};
export type Parsed = {
	pos: string[] /** Each flag given, by its first spelling, with its value (`true` for a flag with none). */;
	flag: Record<string, string | true>;
};
export const DIGITS = /^\d{1,6}$/;
export const TIME = /^[\w:. +-]{1,40}$/;
export const UNIT = /^[A-Za-z0-9@_.:-]{1,100}$/;
export const WORD = /^[A-Za-z0-9_.@:-]{1,64}$/;
export const REPO = /^[\w.-]{1,60}\/[\w.-]{1,100}$/;
export const REF = /^[A-Za-z0-9._/@~^{}-]{1,100}$/;

/**
 * Parses the WHOLE argument list against a spec, never one flag at a time: a flag that is not in the spec is refused, a flag given twice (in any
 * spelling, `-f` then `--format=`) is refused, and the value of every flag given is checked. Returns what was given, or the first fault.
 */
export function parse(args: string[], spec: Spec, what: string): Parsed | Verdict {
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
		const fault = takeFlag(a, rest, { spec, what }, flag);
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
	{ spec, what }: { spec: Spec; what: string },
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
