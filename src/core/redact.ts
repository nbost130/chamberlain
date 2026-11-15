/**
 * Defence in depth for transport and compaction error strings: replace every URL-shaped run with `<url>` before any
 * truncation, log, or store. The transport boundary must discard exception text entirely; this catches other adapters
 * and paths that still hand a string through. The legacy logger also redacts every string field of an old-style line
 * before it is queued for the events table or verbose stdout.
 */

/** A `scheme://…` run, or the same form percent-encoded (`scheme%3A%2F%2F…`). */
const URL_RUN = /[a-zA-Z][a-zA-Z0-9+.-]*(?::\/\/|%3A%2F%2F)[^\s"'<>]*/gi;

/** Every URL-shaped substring becomes `<url>`. Call before any `.slice` that might cut a secret token mid-way. */
export function redactUrls(s: string): string {
	return s.replace(URL_RUN, "<url>");
}

/** Top-level string fields of a legacy log line or its data, with every URL-shaped run replaced. */
export function redactUrlFields<T extends Record<string, unknown>>(fields: T): T {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(fields)) out[k] = typeof v === "string" ? redactUrls(v) : v;
	return out as T;
}
