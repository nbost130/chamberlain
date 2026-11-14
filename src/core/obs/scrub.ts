/**
 * The scrubber backstop (docs/OBSERVABILITY.md section 3, rule 3). The registry's types already refuse anything with text in it; this runs on the row that is
 * about to be written and drops whatever still looks like a credential. A hit is a bug in the registry, not a normal event: each one is counted
 * as `log.redacted`, which must read zero.
 *
 * The rules are data so a test can take one away and watch its own vector get through (src/core/obs/scrub.test.ts).
 */

export type Rule = { name: string; key?: RegExp; value?: RegExp };

export const RULES: readonly Rule[] = [
	{ name: "secret-key", key: /token|secret|authorization|cookie|password|api[-_]?key/i },
	{ name: "bearer", value: /\bBearer\s+\S+/i },
	{ name: "jwt", value: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?/ },
	{ name: "sk-key", value: /\bsk-[A-Za-z0-9_-]{6,}/ },
	{ name: "github-token", value: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/ },
	{ name: "page-key", value: /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/ },
	{ name: "url", value: /\b[a-z][a-z0-9+.-]{1,15}:\/\/\S+/i },
];

/** The name of the first rule that `key` or `value` matches, or undefined. */
export function hit(key: string, value: unknown, rules: readonly Rule[] = RULES): string | undefined {
	for (const r of rules) {
		if (r.key?.test(key)) return r.name;
		if (r.value && typeof value === "string" && r.value.test(value)) return r.name;
		if (r.value && Array.isArray(value) && value.some((x) => typeof x === "string" && r.value?.test(x))) return r.name;
	}
	return undefined;
}

/** The record without the entries a rule matches, and the rules that matched (one name per dropped entry). */
export function scrub<T extends Record<string, unknown>>(
	fields: T,
	rules: readonly Rule[] = RULES,
): { clean: Partial<T>; hits: string[] } {
	const clean: Partial<T> = {};
	const hits: string[] = [];
	for (const [k, v] of Object.entries(fields)) {
		const h = hit(k, v, rules);
		if (h) hits.push(h);
		else clean[k as keyof T] = v as T[keyof T];
	}
	return { clean, hits };
}
