import { inlineScriptSrc, pageLink, readToken, readViewKey, rotateToken } from "../core/capability.ts";
import { CONF } from "../core/config.ts";
import { startup } from "../core/migrate.ts";
import { acceptedHosts, hostPortOf, loadConfigOrExit } from "./server.ts";

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
export function tokenCommand(sub: "link" | "rotate-token") {
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
