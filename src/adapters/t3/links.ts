/**
 * Links to a T3 thread. T3 names a thread by its environment (the server's id) and the thread's id, and writes two kinds of link:
 *
 *   t3-thread://v2/<environmentId>/<threadId>     T3's own reference, as its messages write one; it opens inside T3's client only
 *   t3code://threads/<environmentId>/<threadId>   the T3 Code app's deep link, which a phone's OS hands to the app
 *
 * Which environment a server is: `linkEnvironmentId` on its servers entry, else its `environmentId` (a linked server), else what
 * the server itself reports at `/.well-known/t3/environment`. The home server's entry leaves `environmentId` blank on purpose (that
 * blank is what marks it home), so its id is read from the server. Until it is known there is no link, never a guessed one.
 */
import type { ThreadLinks } from "../../core/adapter.ts";
import { readEnvironment } from "./compat.ts";

/** The app's URL scheme when the entry names none: the App Store build of T3 Code. Its dev and preview builds use t3code-dev and t3code-preview. */
export const DEFAULT_APP_SCHEME = "t3code";

/** A T3 environment id or thread id as a link carries it unencoded: letters, digits and `. _ ~ : -` (a UUID, `mcp:launch:<hex>`). */
const SAFE_ID = /^[A-Za-z0-9._~:-]{1,256}$/;
const SCHEME = /^[a-z][a-z0-9+.-]{0,31}$/;

/**
 * Pure: an id as a link path segment. T3 writes thread ids as they are, colons included (`mcp:launch:<hex>`), and reads a link's id
 * as written before it tries the percent-decoded form, so an id that is already safe goes in unchanged and anything else is encoded.
 */
export const linkSegment = (id: string): string =>
	SAFE_ID.test(id) ? id : encodeURIComponent(id).replace(/%3A/gi, ":");

/** Pure: both links for one thread, or none when the environment or the thread is unknown. A bad scheme drops only the app link. */
export function t3ThreadLinks(
	environmentId: string | undefined,
	threadId: string,
	appScheme = DEFAULT_APP_SCHEME,
): ThreadLinks {
	if (!environmentId || !threadId) return {};
	const env = linkSegment(environmentId);
	const id = linkSegment(threadId);
	return {
		ref: `t3-thread://v2/${env}/${id}`,
		...(SCHEME.test(appScheme) ? { app: `${appScheme}://threads/${env}/${id}` } : {}),
	};
}

/** The entry's options that decide a link. */
export type LinkOptions = {
	origin: string;
	environmentId?: unknown;
	linkEnvironmentId?: unknown;
	appScheme?: unknown;
};

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** How long a failed environment read waits before the next one: a server that is down is not asked on every page refresh. */
export const ENV_RETRY_MS = 60_000;

/**
 * One server's thread links. The configured environment is used as it is; otherwise the first call starts one read of the server's
 * environment document and answers with no link until it lands. `ready()` waits for that read, for a caller that is already async.
 */
export function t3Linker(
	o: LinkOptions,
	deps: { read?: typeof readEnvironment; now?: () => number } = {},
): { links(threadId: string): ThreadLinks; ready(): Promise<void> } {
	const configured = text(o.linkEnvironmentId) ?? text(o.environmentId);
	const scheme = text(o.appScheme) ?? DEFAULT_APP_SCHEME;
	const read = deps.read ?? readEnvironment;
	const now = deps.now ?? Date.now;
	let found: string | undefined;
	let pending: Promise<void> | undefined;
	let failedAt = Number.NEGATIVE_INFINITY;
	const lookup = (): Promise<void> => {
		if (configured || found) return Promise.resolve();
		if (pending) return pending;
		if (now() - failedAt < ENV_RETRY_MS) return Promise.resolve();
		pending = read(o.origin)
			.then((env) => {
				const id = text(env?.environmentId);
				if (id && SAFE_ID.test(id)) found = id;
				else failedAt = now();
			})
			.catch(() => {
				failedAt = now();
			})
			.finally(() => {
				pending = undefined;
			});
		return pending;
	};
	return {
		links: (threadId) => {
			const env = configured ?? found;
			if (!env) void lookup();
			return t3ThreadLinks(env, threadId, scheme);
		},
		ready: lookup,
	};
}
