/**
 * The decision-queue page: bun src/web/server.ts [--test | link | rotate-token]
 *
 *   (no argument)   serve the page. Every request must prove it holds the install's capability token (src/core/capability.ts).
 *   link            print the page's links with the token on them: the one to open on a phone or laptop, and the inline view's script address
 *   rotate-token    make a new token; every old link, cookie and rendered view stops working at once, and the new links are printed
 *
 * Binds only to the address in the `web` section of ~/.config/chamberlain/config.json (loopback or a Tailscale IP) and refuses a wildcard or a
 * missing one. An answer's wake is an outbox row written in the answer's own transaction; the daemon's relay sends it (src/core/relay.ts).
 *
 * --test runs against fixture data: CHAMBERLAIN_CONF and CHAMBERLAIN_STATE must point away from the live directories, the
 * address must be loopback, no wake is sent and no card is touched.
 */

import { loadServers, makeAdapter } from "../adapters/index.ts";
import type { Adapter } from "../core/adapter.ts";
import { has } from "../core/adapter.ts";
import {
	ensureToken,
	ensureViewKey,
	fileCapability,
	inlineScriptSrc,
	pageLink,
	readToken,
	readViewKey,
	rotateToken,
} from "../core/capability.ts";
import { CONF, STATE } from "../core/config.ts";
import { defaultStore } from "../core/default-store.ts";
import { readNamed } from "../core/layout.ts";
import { type Logger, logFor } from "../core/log.ts";
import { maintain } from "../core/maintain.ts";
import { startup } from "../core/migrate.ts";
import type { ServerEntry } from "../core/servers.ts";
import { configDir, stateDir } from "../core/state-dir.ts";
import { STATIC_FILES } from "../embedded.ts";
import { createApp } from "./app.ts";
import { loadConfig, type WebConfig } from "./config.ts";
import { createLinker } from "./thread-links.ts";
import { titleKeeper } from "./title.ts";
import { createWaiting, type ServerAdapter, threadSender, withAnswerRights } from "./waiting.ts";

/** The Host header values the page accepts: its bind address and every allowed host name, bare and with the port. Anything else gets 421. */
export function acceptedHosts(cfg: { host: string; port: number; allowedHosts?: string[] }): string[] {
	return [hostPortOf(cfg), ...(cfg.allowedHosts ?? []).flatMap((h) => [h, `${h}:${cfg.port}`])];
}
/** Pure: the page's bind address with its port, an IPv6 address in brackets. */
const hostPortOf = (cfg: { host: string; port: number }): string =>
	cfg.host.includes(":") ? `[${cfg.host}]:${cfg.port}` : `${cfg.host}:${cfg.port}`;

/**
 * The addresses the page answers on, as links: the one `publicBase` names (an https address from `tailscale serve`), the bind address, and every
 * allowed host name. A `publicBase` whose host the page would refuse (421, because it is not in `allowedHosts`) is left out and named in `skipped`:
 * a link that cannot work is not printed.
 */
export function pageBases(cfg: { host: string; port: number; allowedHosts?: string[]; publicBase?: string }): string[] {
	return linkTargets(cfg).bases;
}
export function linkTargets(cfg: { host: string; port: number; allowedHosts?: string[]; publicBase?: string }): {
	bases: string[];
	skipped: string[];
} {
	const accepted = acceptedHosts(cfg);
	const hostPort = hostPortOf(cfg);
	const skipped: string[] = [];
	const bases: string[] = [];
	if (cfg.publicBase && /^https:\/\/[^/\s]+$/.test(cfg.publicBase)) {
		const h = new URL(cfg.publicBase).host;
		if (accepted.includes(h)) bases.push(cfg.publicBase);
		else
			skipped.push(
				`${cfg.publicBase} (add "${h}" to "allowedHosts" in the web section, or the page answers 421 on it)`,
			);
	}
	bases.push(`http://${hostPort}`, ...(cfg.allowedHosts ?? []).map((h) => `http://${h}:${cfg.port}`));
	return { bases: [...new Set(bases)], skipped };
}

/**
 * Pure: what `chamberlain web link` prints. The page key is in the page link, on purpose: it is the link. The script tag carries the VIEW key,
 * the weak one: that is the only key that belongs in a Decisions message.
 */
export function linkLines(
	bases: string[],
	token: string,
	viewKey: string | undefined,
	skipped: string[] = [],
): string[] {
	return [
		"Open one of these on any device that can reach the page. It signs the browser in (a long-lived cookie) and then drops the key from the address:",
		...bases.map((b) => `  ${pageLink(b, token)}`),
		"",
		...(viewKey
			? [
					"For the Decisions thread's setup message (docs/decisions-thread-setup.md), the script tag of the inline view, ready to paste into its html. It carries the view key, which can only read the queue and answer a question:",
					...bases.map((b) => `  <script src="${inlineScriptSrc(b, viewKey).replaceAll("&", "&amp;")}"></script>`),
				]
			: [
					"The page has no view key yet, so there is no script tag for the Decisions thread: start the page (chamberlain web), then run web link again.",
				]),
		"",
		"Treat the page link like a password: anyone who holds it can use the whole page and answer for you. Never paste it into a thread. `chamberlain web rotate-token` ends every copy.",
		...skipped.map((x) => `Not printed, because the page would refuse it: ${x}`),
	];
}

/**
 * `chamberlain web link` and `chamberlain web rotate-token`. `link` only READS the token: a install whose page has never started has none, and
 * a link made now would be one the page later disagrees with, so it says to start the page first and exits 1. `rotate-token` is the command that
 * makes a new one.
 */
function tokenCommand(sub: "link" | "rotate-token") {
	startup();
	const t = linkTargets(loadConfigOrExit());
	if (sub === "rotate-token") {
		const token = rotateToken(CONF);
		console.log(
			"rotated: every old link, browser cookie and already-rendered view that carries the old page key stops working now. The view key is unchanged. The new links:\n",
		);
		let viewKey: string | undefined;
		try {
			viewKey = readViewKey(CONF);
		} catch {
			viewKey = undefined; // not a private file: the page will not accept it either, and says so when it starts
		}
		for (const l of linkLines(t.bases, token, viewKey, t.skipped)) console.log(l);
		return;
	}
	let token: string | undefined;
	let viewKey: string | undefined;
	try {
		token = readToken(CONF);
		viewKey = readViewKey(CONF);
	} catch (e) {
		console.error(`the page's key could not be read: ${String((e as Error).message).slice(0, 160)}`);
		process.exitCode = 1;
		return;
	}
	if (!token) {
		console.error("the page has no key yet: start the page first (chamberlain web), then run web link again");
		process.exitCode = 1;
		return;
	}
	for (const l of linkLines(t.bases, token, viewKey, t.skipped)) console.log(l);
}

/** The page's config, or the reason it cannot be read on stderr and exit code 2. */
function loadConfigOrExit(): WebConfig {
	try {
		return loadConfig(CONF);
	} catch (e) {
		console.error(String((e as Error).message));
		process.exit(2);
	}
}

/** `--test` runs only against scratch directories: both are set and neither is the live one for this home. */
function requireScratchDirectories(): void {
	const HOME = process.env.HOME ?? "";
	if (
		!process.env.CHAMBERLAIN_CONF ||
		!process.env.CHAMBERLAIN_STATE ||
		CONF === configDir({}, HOME) ||
		STATE === stateDir({}, HOME)
	) {
		console.error(
			"--test needs CHAMBERLAIN_CONF and CHAMBERLAIN_STATE pointed at scratch directories, never the live ones",
		);
		process.exit(2);
	}
}

/** Serves the page until stopped. `argv` is the arguments after the command: `--test`, or `link` or `rotate-token`. */
export async function main(argv: string[] = process.argv.slice(2)) {
	if (argv[0] === "link" || argv[0] === "rotate-token") return tokenCommand(argv[0]);
	const TEST = argv.includes("--test");
	if (TEST) requireScratchDirectories();
	const cfg = loadConfigOrExit();
	if (TEST && !["127.0.0.1", "::1"].includes(cfg.host)) {
		console.error("--test binds to loopback only");
		process.exit(2);
	}

	const store = defaultStore();
	const log = logFor(store, { src: "queue-web" });
	const privateFile = (name: string) => readNamed(CONF, name);
	// The daemon raises alarms; the page only logs them, so a page problem never alerts the principal twice.
	// Refuse a file from a newer Chamberlain, and upgrade older ones, before anything reads them.
	startup({ migrate: true, log });
	// The page's capability: made on the first start, kept in secrets/web-token, followed if `chamberlain web rotate-token` replaces it.
	ensureToken(CONF);
	// The view key a Decisions post carries instead of that token: made once, never replaced by a start (src/core/capability.ts).
	ensureViewKey(CONF);
	maintain(store);
	const qs = cfg.decisionsServer;
	const servers = serverAdapters(cfg, store, log);
	const mirror = TEST
		? undefined
		: createWaiting({
				store,
				servers,
				// The Decisions thread is never mirrored: its own views carry the queue.
				skipThreads: () => [privateFile("decisions-thread")].filter((x): x is string => Boolean(x)),
				links: cfg.mirrorLinks,
				log,
			});
	const app = makeApp(cfg, TEST, store, log, servers, mirror);
	const server = Bun.serve({ hostname: cfg.host, port: cfg.port, fetch: app.fetch });
	// The Decisions thread title shows the open count, on the server that hosts that thread and whose adapter can set a title;
	// until the rights are there it keeps its fixed title.
	const decisions = privateFile("decisions-thread");
	const titled =
		qs && decisions ? servers().find((x) => x.server.origin === qs.origin && has(x.adapter, "setTitle")) : undefined;
	const keepTitle = TEST ? undefined : titleKeeperFor(titled, app.openCount, log);
	log("web-start", { host: cfg.host, port: server.port, test: TEST, title: keepTitle ? "live" : "fixed" });
	// The address only: the links with the key on them are `chamberlain web link`, never this log.
	console.log(
		`Chamberlain decision queue on http://${hostPortOf(cfg)}${TEST ? " (test mode: no wakes)" : ""}. Every request needs the page's key: run \`chamberlain web link\` for the links.`,
	);
	await runLoops(app, mirror, keepTitle, log);
}

/** The page's app over the store and the server adapters. */
function makeApp(
	cfg: WebConfig,
	TEST: boolean,
	store: ReturnType<typeof defaultStore>,
	log: Logger,
	servers: () => ServerAdapter[],
	mirror: ReturnType<typeof createWaiting> | undefined,
) {
	return createApp({
		capability: fileCapability(CONF),
		store,
		state: STATE,
		log,
		// A thread-routed answer goes to its thread through its server's adapter (`send`), where it has the rights; test mode sends nothing.
		sendToThread: TEST ? undefined : threadSender(servers),
		hosts: acceptedHosts(cfg),
		// Each card's thread link: the config's prefix for its server when it names one, else the server adapter's own.
		links: createLinker({ servers, threadLinks: cfg.threadLinks, mirrorLinks: cfg.mirrorLinks }),
		staticFiles: STATIC_FILES,
		testMode: TEST,
		mirror,
	});
}

/**
 * Cards waiting in any thread on any server, shown on the queue; answerable where the server's adapter can answer and was
 * granted rights. The Decisions server's comes from web.json (decisionsServer), the others' from web.json's answerTokens; any
 * server without one is read-only. servers.json is read again on every poll, and an adapter is kept while its entry is unchanged.
 */
function serverAdapters(cfg: WebConfig, store: ReturnType<typeof defaultStore>, log: Logger): () => ServerAdapter[] {
	const alarm = (key: string, title: string) => log("alarm", { key, title });
	const pool = new Map<string, { key: string; adapter: Adapter }>();
	return () => {
		try {
			// Answer rights come only from web.json. Any operateTokenFile a servers.json entry carries is dropped.
			const list: ServerEntry[] = withAnswerRights(loadServers(CONF), cfg.decisionsServer, cfg.answerTokens);
			log.obs.allow(
				"server",
				list.map((server) => server.name),
			);
			const out = list.map((server) => {
				const key = JSON.stringify(server);
				let held = pool.get(server.name);
				if (!held || held.key !== key) {
					held = {
						key,
						adapter: makeAdapter(server, { conf: CONF, state: STATE, store, log, alarm: (k, t) => alarm(k, t) }),
					};
					pool.set(server.name, held);
				}
				return { server, adapter: held.adapter };
			});
			for (const name of pool.keys()) if (!list.some((x) => x.name === name)) pool.delete(name);
			return out;
		} catch (e) {
			log("mirror-servers-error", { error: String(e).slice(0, 200) });
			return [];
		}
	};
}

/** The title keeper for the Decisions thread, when its server's adapter can set a title (else the title stays fixed). */
function titleKeeperFor(
	titled: ServerAdapter | undefined,
	openCount: Parameters<typeof titleKeeper>[0],
	log: Logger,
): (() => Promise<void>) | undefined {
	const adapter = titled?.adapter;
	if (!adapter || !has(adapter, "setTitle")) return undefined;
	return titleKeeper(openCount, (title) => adapter.setTitle(title), log);
}

/** The page's recovery and mirror polls: each once now, then on its interval. A failure is logged and never stops the next. */
async function runLoops(
	app: ReturnType<typeof createApp>,
	mirror: ReturnType<typeof createWaiting> | undefined,
	keepTitle: (() => Promise<void>) | undefined,
	log: Logger,
): Promise<void> {
	const tick = async () => {
		try {
			await app.recover();
		} catch (e) {
			log("recover-error", { error: String(e) });
		}
	};
	// Startup recovery: every page claim whose wake is neither delivered nor in the outbox is written to the outbox now.
	await tick();
	log("startup-recovered");
	setInterval(tick, 60_000);
	// The mirror reads first, so the title counts mirrored cards from its first rename.
	const pollMirror = async () => {
		try {
			await mirror?.poll();
		} catch (e) {
			log("mirror-error", { error: String(e).slice(0, 200) });
		}
	};
	await pollMirror();
	if (mirror) setInterval(pollMirror, 15_000);
	if (keepTitle) {
		await keepTitle();
		setInterval(keepTitle, 15_000);
	}
}

if (import.meta.main) await main();
