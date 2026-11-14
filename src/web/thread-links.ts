/**
 * Which link a card gives for its thread, and where the page's `/open/<server>/<threadId>` route sends a device.
 *
 * A card's `link` is the thread's reference: the page config's prefix for its server when there is one (`threadLinks` for a question
 * asked with `chamberlain ask`, `mirrorLinks` for a card read from a thread), else the server adapter's own (`Adapter.threadLinks`).
 *
 * A link in the inline view must be http(s): T3 Code's html_render frame opens nothing else (its web client forwards only an http(s)
 * link to the app, and its phone app hands only an http(s) link to the browser). So the view links to the page's `/open` route, and that
 * route sends the device on to `target`: an http(s) prefix from the config when there is one, else the adapter's app link (which a
 * phone's OS opens in the backend's app). The target is always made here, from the server name and thread id: never a URL a request carried.
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
		return r.own.app ?? (isHttp(r.own.ref) ? r.own.ref : undefined);
	};
	return {
		link,
		target,
		openPath: (server, threadId) =>
			target(server, threadId) ? `/open/${encodeURIComponent(server)}/${encodeURIComponent(threadId)}` : undefined,
	};
}

/** Pure: the page `/open` serves. It goes on to `target` by itself, and keeps a link to tap for a browser that waits to be asked. No script or style: the page's CSP allows neither inline. */
export function openPage(target: string, label: string): string {
	const esc = (s: string) =>
		s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="refresh" content="0;url=${esc(target)}"><title>Open the thread</title></head><body><p><a href="${esc(target)}">Open ${esc(label)}</a></p><p>If nothing opened, the app that opens this thread is not on this device.</p></body></html>`;
}
