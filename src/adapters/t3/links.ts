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
import type { ThreadLinks } from "../../core/adapter-waiting.ts";
import { readEnvironment } from "./compat.ts";

/** The app's URL scheme when the entry names none: the App Store build of T3 Code. Its dev and preview builds use t3code-dev and t3code-preview. */
export const DEFAULT_APP_SCHEME = "t3code";

/** An environment id as a link carries it: T3 issues a UUID; letters, digits and `. _ ~ : -` are accepted, anything else is no link. */
const SAFE_ID = /^[A-Za-z0-9._~:-]{1,256}$/;
const SCHEME = /^[a-z][a-z0-9+.-]{0,31}$/;

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
/** One part of an id T3 joins with `:` after `encodeURIComponent` (IdAllocator.ts `joinId`); `! * ' ( )` are left out, so no id needs encoding again. */
const PART = "(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+";
/**
 * The thread id shapes T3 Code issues (t3code `apps/server` and `packages/provider-core`), and only those:
 *   - a UUID: a thread a client creates;
 *   - `mcp:<uuid>`: a thread an agent starts over MCP (`mcp/threadAccess.ts`: a command id `mcp:<uuid>` becomes the thread id);
 *   - `mcp:launch:<64 hex>`: a launched thread, the SHA-256 of its key (`mcp/toolkits/project/handlers.ts` `launchCommandId`);
 *   - `thread:<kind>:<part>:...`: an id `joinId("thread", ...)` derives, each part URL-encoded (`provider-core/src/server/IdAllocator.ts`:
 *     `delegated-task`, `provider:<driver>:native-thread:<id>`, and the `project:<uuid>:<uuid>` threads in a 0.1.9 database);
 *   - `import:<providerInstanceId>:<providerSessionId>`: an imported agent session (`project/AgentSessionImporter.ts`).
 * Every id in this machine's T3 database (1557 threads, 2026-11-14) is one of these. Anything else gets no link.
 */
const THREAD_ID = new RegExp(
	`^(?:${UUID}|mcp:${UUID}|mcp:launch:[0-9a-f]{64}|thread:[a-z][a-z-]*(?::${PART})+|import:[A-Za-z0-9._-]+:[A-Za-z0-9._-]+)$`,
);

/** Pure: is this a thread id T3 issues? Its characters are all ones a link carries as they are, so a valid id is never re-encoded. */
export const isT3ThreadId = (id: string): boolean => id.length <= 512 && THREAD_ID.test(id);

/**
 * Pure: both links for one thread. `undefined` when the id is not a T3 thread id (nothing links to it, whatever the config says);
 * `{}` when it is but the environment is unknown or not an id. The id goes in as T3 writes it, colons and percent escapes included:
 * T3 reads a link's id as written. A bad scheme drops only the app link.
 */
export function t3ThreadLinks(
	environmentId: string | undefined,
	threadId: string,
	appScheme = DEFAULT_APP_SCHEME,
): ThreadLinks | undefined {
	if (!isT3ThreadId(threadId)) return undefined;
	if (!environmentId || !SAFE_ID.test(environmentId)) return {};
	return {
		ref: `t3-thread://v2/${environmentId}/${threadId}`,
		...(SCHEME.test(appScheme) ? { app: `${appScheme}://threads/${environmentId}/${threadId}` } : {}),
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
/** How long a read environment id is kept before it is read again in the background (it changes only when T3 is set up anew). */
export const ENV_REFRESH_MS = 6 * 3600_000;

/**
 * One server's thread links. A configured environment is used as it is. Otherwise the server's environment document is read in the
 * background, never on the caller's path: `links` answers at once with what is known (no link before the first read lands) and
 * starts a read when none is known or the known one is older than ENV_REFRESH_MS; a refresh that fails keeps the id it had.
 * `ready()` starts the same read and resolves when it ends, for warming up and for tests.
 */
export function t3Linker(
	o: LinkOptions,
	deps: { read?: typeof readEnvironment; now?: () => number } = {},
): { links(threadId: string): ThreadLinks | undefined; ready(): Promise<void> } {
	const configured = text(o.linkEnvironmentId) ?? text(o.environmentId);
	const scheme = text(o.appScheme) ?? DEFAULT_APP_SCHEME;
	const read = deps.read ?? readEnvironment;
	const now = deps.now ?? Date.now;
	let found: string | undefined;
	let foundAt = Number.NEGATIVE_INFINITY;
	let pending: Promise<void> | undefined;
	let failedAt = Number.NEGATIVE_INFINITY;
	const lookup = (): Promise<void> => {
		if (configured) return Promise.resolve();
		if (pending) return pending;
		if (found && now() - foundAt < ENV_REFRESH_MS) return Promise.resolve();
		if (now() - failedAt < ENV_RETRY_MS) return Promise.resolve();
		pending = read(o.origin)
			.then((env) => {
				const id = text(env?.environmentId);
				if (id && SAFE_ID.test(id)) {
					found = id;
					foundAt = now();
				} else failedAt = now();
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
			if (!configured) void lookup();
			return t3ThreadLinks(configured ?? found, threadId, scheme);
		},
		ready: lookup,
	};
}
