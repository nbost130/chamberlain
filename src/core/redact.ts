/**
 * Defence in depth for transport and compaction error strings: replace every URL-shaped run with `<url>` before any
 * truncation, log, or store. The transport boundary must discard exception text entirely; this catches other adapters
 * and paths that still hand a string through.
 */

/** A `scheme://…` run, or the same form percent-encoded (`scheme%3A%2F%2F…`). */
const URL_RUN = /[a-zA-Z][a-zA-Z0-9+.-]*(?::\/\/|%3A%2F%2F)[^\s"'<>]*/gi;

/** Every URL-shaped substring becomes `<url>`. Call before any `.slice` that might cut a secret token mid-way. */
export function redactUrls(s: string): string {
	return s.replace(URL_RUN, "<url>");
}
