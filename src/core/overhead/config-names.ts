/** The small readers the `overhead` section's parsers share: names that may reach a GitHub search or a database query, and plain numbers. */
import { num, str } from "../config/config-fields.ts";

export type Obj = Record<string, unknown>;

/** A name that goes into a GitHub search or a database query: letters, digits and a few separators, so nothing in it can change the statement. */
const SAFE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,80}$/;
export const SAFE_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/;

/** A list of plain names (or, with `SAFE_REPO`, of `owner/name` repositories); left out is an empty list. */
export function names(o: Obj, k: string, where: string, ok: RegExp = SAFE): string[] {
	const v = o[k];
	if (v === undefined) return [];
	if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !ok.test(x)))
		throw Error(
			`${where}: ${k} must be a list of ${ok === SAFE_REPO ? "owner/name repositories" : "plain names (letters, digits, space . _ -)"}`,
		);
	return v as string[];
}

export const plain = (o: Obj, k: string, where: string, d: string): string => {
	const v = str(o, k, where, d);
	if (!SAFE.test(v)) throw Error(`${where}: ${k} must be a plain name (letters, digits, space . _ -)`);
	return v;
};

export const hours = (o: Obj, k: string, where: string, d: number) => num(o, k, where, { d, whole: false });
