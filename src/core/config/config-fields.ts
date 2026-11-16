/**
 * The checks every config section is parsed with: an object whose keys are all known, and a boolean, a number, a string or a
 * probability with a default for what is left out. Each throws one line naming the section (`where`) and the key. Shared by
 * `sweep.idleParents.classifier` (src/core/classifier/config.ts) and the optional modules' sections (src/modules/), so a section
 * means the same thing by "unknown key" and "positive whole number" everywhere.
 */

export type Obj = Record<string, unknown>;

/** The section as an object whose every key is one of `keys`; anything else throws. */
export function object(raw: unknown, where: string, keys: readonly string[]): Obj {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error(`${where}: expected an object`);
	const o = raw as Obj;
	for (const k of Object.keys(o))
		if (!keys.includes(k)) throw Error(`${where}: unknown key "${k}" (known: ${keys.join(", ")})`);
	return o;
}

export const bool = (o: Obj, k: string, where: string, d: boolean): boolean => {
	if (o[k] === undefined) return d;
	if (typeof o[k] !== "boolean") throw Error(`${where}: ${k} must be true or false`);
	return o[k] as boolean;
};

/** How a number setting is read: its default, whether it must be whole, and whether zero is allowed. */
export type NumSpec = { d: number; whole: boolean; zeroOk?: boolean };

export const num = (o: Obj, k: string, where: string, { d, whole, zeroOk = false }: NumSpec): number => {
	const v = o[k];
	if (v === undefined) return d;
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (!zeroOk && v === 0) || (whole && !Number.isInteger(v)))
		throw Error(`${where}: ${k} must be a ${zeroOk ? "non-negative" : "positive"} ${whole ? "whole " : ""}number`);
	return v;
};

export const str = (o: Obj, k: string, where: string, d: string): string => {
	const v = o[k];
	if (v === undefined) return d;
	if (typeof v !== "string" || !v.trim()) throw Error(`${where}: ${k} must be a non-empty string`);
	return v;
};

/** One of `allowed`, or `d` when left out. */
export function oneOf<T extends string>(
	o: Obj,
	k: string,
	where: string,
	{ allowed, d }: { allowed: readonly T[]; d: T },
): T {
	const v = o[k] ?? d;
	if (typeof v !== "string" || !(allowed as readonly string[]).includes(v))
		throw Error(`${where}: ${k} must be one of ${allowed.join(", ")}`);
	return v as T;
}

/** The `mode` of an authority feature: `shadow` (record only, the default) or `live`. */
export function modeOf(o: Obj, where: string, d: "shadow" | "live"): "shadow" | "live" {
	const mode = o.mode ?? d;
	if (mode !== "shadow" && mode !== "live") throw Error(`${where}: mode must be shadow or live`);
	return mode;
}

/** Whether a value is a program and its arguments: a non-empty list of non-empty strings. */
export const isArgv = (v: unknown): v is string[] =>
	Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string" && x !== "");

/** A string the section must give: left out is an error, not an empty default. */
export const required = (o: Obj, k: string, where: string): string => {
	if (o[k] === undefined) throw Error(`${where}: ${k} is required`);
	return str(o, k, where, "");
};

export const probability = (v: unknown, where: string): number => {
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)
		throw Error(`${where} must be a number from 0 to 1`);
	return v;
};
