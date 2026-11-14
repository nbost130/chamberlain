/**
 * Which link a card gives for its thread, and where the page's `/open/<server>/<threadId>` route sends a device.
 *
 * A card's `link` is the thread's reference: the page config's prefix for its server when there is one (`threadLinks` for a question
 * asked with `chamberlain ask`, `mirrorLinks` for a card read from a thread), else the server adapter's own (`Adapter.threadLinks`).
 *
 * Two ways out of a view, chosen by where the view is shown (static/inline.js):
 *   - `app`: the adapter's app link (T3: `t3code://threads/<env>/<thread>`), for a view that is the top document of an app's own web
 *     view. T3 Code's phone app shows an inline page that way, and hands any link that is not http(s) to the phone's OS, which opens the
 *     app's own link in the app itself: the thread opens in place, with no browser. Only when the target IS the app link (no http(s)
 *     override from the config) and its scheme is one no browser runs (`isAppLink`).
 *   - `open`: the page's `/open` route, for every other view (T3's web and desktop clients show an inline page in a sandboxed frame that
 *     opens only http(s)). The route sends the device on to `target`: an http(s) prefix from the config when there is one, else the
 *     adapter's app link. A tap gets a redirect straight to it; any other load gets a page that goes on by itself and keeps a link to tap.
 * Every target is made here, from the server name and thread id: never a URL a request carried.
 */
import { has, type ThreadLinks } from "../core/adapter.ts";
import type { ServerAdapter } from "./waiting.ts";

export type Linker = {
	/** The link a question asked with `chamberlain ask` gives for its thread, or undefined when none can be made. */
	link(server: string, threadId: string): string | undefined;
	/** Where `/open/<server>/<threadId>` sends a device, or undefined when nothing would open. */
	target(server: string, threadId: string): string | undefined;
	/** The page path that opens a thread: `/open/<server>/<threadId>` when `target` has somewhere to go. */
	openPath(server: string, threadId: string): string | undefined;
	/** The app link a view inside the backend's own app opens directly: `target` when it is an app link (`isAppLink`), else undefined. */
	appLink(server: string, threadId: string): string | undefined;
};

export type LinkerDeps = {
	/** The servers and their adapters, read fresh on every call. */
	servers: () => ServerAdapter[];
	/** web.threadLinks: server name -> a prefix the encoded thread id is appended to. */
	threadLinks?: Record<string, string>;
	/** web.mirrorLinks: server name -> a prefix the thread id is appended to, for a card read from a thread. */
	mirrorLinks?: Record<string, string>;
};

/** A server name the page will make a link for. */
const SERVER = /^[A-Za-z0-9._~-]{1,128}$/;
/** A thread id for a server whose adapter cannot vouch for its ids (no `threadLinks`): only a config prefix links it then. */
const ANY_ID = /^[A-Za-z0-9._~:%-]{1,512}$/;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);
const isHttp = (u: string | undefined): u is string => !!u && /^https?:\/\//i.test(u);
/** Schemes a browser or web view runs or loads itself: never an app link, whatever the config names. */
const BROWSER_SCHEMES = new Set([
	"javascript",
	"vbscript",
	"data",
	"file",
	"blob",
	"about",
	"filesystem",
	"http",
	"https",
	"ws",
	"wss",
	"ftp",
]);
/**
 * Pure: is this an app link a view may use as an href? `<scheme>://<rest>`, the scheme lowercase and not one a browser runs or loads
 * (BROWSER_SCHEMES), the rest only unreserved characters, `:`, `/` and percent escapes: no space, quote, angle bracket or backslash.
 * static/inline.js checks the same shape before it makes one an href.
 */
export const isAppLink = (u: unknown): u is string => {
	if (typeof u !== "string" || u.length > 1100) return false;
	const m = /^([a-z][a-z0-9+.-]{0,31}):\/\/[A-Za-z0-9._~:%/-]{1,1024}$/.exec(u);
	const scheme = m?.[1];
	return scheme !== undefined && !BROWSER_SCHEMES.has(scheme);
};
const prefix = (m: Record<string, string> | undefined, server: string) =>
	m && Object.hasOwn(m, server) && typeof m[server] === "string" && m[server] ? m[server] : undefined;

export function createLinker(d: LinkerDeps): Linker {
	/**
	 * The server's own links for a thread, or undefined when nothing may link to it: a server not in `servers` (a config prefix for a
	 * removed server links nothing), a malformed name, or an id the server's adapter says is not one of its threads.
	 */
	const resolve = (server: string, threadId: string): { own: ThreadLinks } | undefined => {
		if (!SERVER.test(server) || RESERVED.has(server)) return undefined;
		const s = d.servers().find((x) => x.server.name === server);
		if (!s) return undefined;
		if (!has(s.adapter, "threadLinks")) return ANY_ID.test(threadId) ? { own: {} } : undefined;
		const own = s.adapter.threadLinks(threadId);
		return own ? { own } : undefined;
	};
	const link = (server: string, threadId: string) => {
		const r = resolve(server, threadId);
		if (!r) return undefined;
		const p = prefix(d.threadLinks, server);
		return p ? p + encodeURIComponent(threadId) : r.own.ref;
	};
	const target = (server: string, threadId: string) => {
		const r = resolve(server, threadId);
		if (!r) return undefined;
		const tp = prefix(d.threadLinks, server);
		const mp = prefix(d.mirrorLinks, server);
		const fromConfig = [tp && tp + encodeURIComponent(threadId), mp && mp + threadId].find(isHttp);
		if (fromConfig) return fromConfig;
		// An app link only of a scheme no browser runs (a misconfigured `appScheme: "javascript"` is never a target).
		return (isAppLink(r.own.app) ? r.own.app : undefined) ?? (isHttp(r.own.ref) ? r.own.ref : undefined);
	};
	return {
		link,
		target,
		openPath: (server, threadId) =>
			target(server, threadId) ? `/open/${encodeURIComponent(server)}/${encodeURIComponent(threadId)}` : undefined,
		appLink: (server, threadId) => {
			const t = target(server, threadId);
			return isAppLink(t) ? t : undefined;
		},
	};
}

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/**
 * Pure: the page `/open` serves when the request is not a tap (`Sec-Fetch-User` absent: a reload, a link another app handed the
 * browser, a browser older than Safari 16.4). It goes on to `target` by itself (a meta refresh: Chrome on Android and desktop browsers
 * follow it to an app link as part of the tap that led here; Safari on iOS opens an app only from a tap, so there the button below is
 * the way), and says plainly what to do if nothing opened. No script or inline style: the page's CSP allows neither; its look comes
 * from the page's own stylesheet.
 */
export function openPage(target: string, label: string): string {
	const esc = (s: string) => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
	const app = !isHttp(target);
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="0;url=${esc(target)}"><title>Opening the thread</title><link rel="stylesheet" href="/app.css"></head><body class="open-page"><main class="open-box"><h1>Opening ${esc(label)}…</h1><p><a class="open-go" href="${esc(target)}">Open ${esc(label)}</a></p><p class="open-why">${app ? "Nothing opened? Tap the button: some browsers (Safari on iPhone) open an app only from a tap. If it still does nothing, the app is not installed on this device." : "Nothing opened? Tap the button."}</p></main></body></html>`;
}
