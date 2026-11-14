/** The pages: evidence, the static shell, the key and origin checks, links, and what a request is refused. */
import { TOKEN_HEADER, TOKEN_PARAM } from "../core/capability.ts";
import type { AppDeps, Ctx } from "./app-ctx.ts";
import { fail, inlineCors, inlineVerdict, isJsonContentType, withSecurity } from "./app-http.ts";
import { resolveEvidence } from "./evidence.ts";
import { openPage } from "./thread-links.ts";

function evidence(ctx: Ctx, url: URL): Response {
	const { d } = ctx;
	const parts = url.pathname.split("/").filter(Boolean);
	if (parts.length !== 3) return fail(404, "not found");
	const [, rawItem = "", rawName = ""] = parts;
	let itemId: string, name: string;
	try {
		itemId = decodeURIComponent(rawItem);
		name = decodeURIComponent(rawName);
	} catch {
		return fail(404, "not found");
	}
	const item = ctx.state().get(itemId);
	const listed = (item?.evidence ?? []).flatMap((e) => (e.type !== "link" && e.path ? [e.path] : []));
	const hit = resolveEvidence(d.state, itemId, name, listed);
	if (!hit) return fail(404, "not found");
	return new Response(Bun.file(hit.path), {
		headers: { "content-type": hit.type, "cache-control": "private, max-age=3600" },
	});
}

const staticPath = (d: AppDeps, name: string) => d.staticFiles?.[name] ?? `${d.staticDir}${name}`;
const STATIC: Record<string, string> = {
	"/app.js": "text/javascript; charset=utf-8",
	"/app.css": "text/css; charset=utf-8",
	"/inline.js": "text/javascript; charset=utf-8",
};

/** The page a browser without the key gets: static, and it says how to get one. */
const LOCKED_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Decisions</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px"><h1 style="font-size:1.2rem">This page needs its link</h1><p>Open the link Chamberlain gave you. To get a fresh one, run <code>chamberlain web link</code> on the machine that runs Chamberlain.</p></body></html>`;
const locked = (inlineReply: boolean) => {
	// Plain text, not JSON: a frame still running the previous build's script reads every reply as JSON, and would show an empty queue for a
	// JSON error object. A text body makes it fail loudly ("could not reach the queue") instead.
	const r = withSecurity(
		new Response("Locked: this request carries no valid key. Run `chamberlain web link` for a fresh link.\n", {
			status: 401,
			headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
		}),
	);
	r.headers.set("www-authenticate", "Bearer");
	return inlineReply ? inlineCors(r) : r;
};
export const isShell = (p: string) => p === "/" || p === "/rulings" || /^\/item\/Q-[a-z0-9]{4,16}$/.test(p);
/** `/open/<server>/<threadId>`: sends a device on to the thread's link (./thread-links.ts). A link, like a page: `?k=` signs it in. */
export const isOpen = (p: string) => /^\/open\/[^/]+\/[^/]+$/.test(p);
/**
 * Did the person start this navigation with a tap or a click (`Sec-Fetch-User: ?1`, Fetch Metadata; Safari 16.4+, Chrome, Firefox)?
 * Then `/open` answers with a redirect straight to the app: a browser follows a redirect to an app link only inside a navigation the
 * person started (Safari on iOS drops a page's own meta refresh or script navigation to one). Anything else gets the page.
 */
const tapped = (req: Request) => req.headers.get("sec-fetch-user") === "?1";

/** Who a request says it is: whether it comes from an inline frame, and whether that frame may do what it asked. */
type Gate = { inline: boolean; allowed: boolean; origin: string | null; sameOrigin: boolean };

/** Checks Host and Origin: a refusal (or the answer to a preflight) as a Response, or the request's Gate. */
export function checkOrigin(d: AppDeps, req: Request, url: URL): Response | Gate {
	// The page binds to one address. A Host it doesn't know is a rebinding attempt or a mistake.
	if (!d.hosts.includes(req.headers.get("host") ?? "")) return withSecurity(fail(421, "unknown host"));
	const origin = req.headers.get("origin");
	const sameOrigin = origin !== null && d.hosts.some((h) => origin === `http://${h}` || origin === `https://${h}`);
	// T3 shows inline pages in a sandboxed frame whose origin is "null". It is let in only with the capability token (below), and then only
	// for what inlineVerdict allows: three reads, and an answer that is a choice and a note. It cannot save a ruling, answer a card or an
	// approval, read one item, or change anything else. A page on any other origin is refused outright, whatever it sends.
	const inline = origin === "null";
	if (origin !== null && !inline && !sameOrigin) return withSecurity(fail(403, "refused: cross-origin request"));
	const verdict = inline ? inlineVerdict(req.method, url.pathname) : undefined;
	// A null-origin request outside the list is refused whatever it is. (Static files carry no Origin when a frame loads them.)
	if (inline && verdict === "refuse" && (url.pathname.startsWith("/api/") || req.method !== "GET"))
		return withSecurity(
			fail(403, "refused: an inline frame may read the queue, recent answers and rulings, and answer a question"),
		);
	const allowed = inline && verdict !== "refuse";
	// A preflight cannot carry the token, so it is answered; it grants nothing, and the request it clears is checked below.
	if (allowed && req.method === "OPTIONS") return withSecurity(inlineCors(new Response(null, { status: 204 })));
	return { inline, allowed, origin, sameOrigin };
}

/** Static files are the page's own code and carry no data: served to any request that reached the right Host. */
export function staticResponse(d: AppDeps, req: Request, url: URL): Response | undefined {
	const type = req.method === "GET" ? STATIC[url.pathname] : undefined;
	if (!type) return undefined;
	return withSecurity(
		new Response(Bun.file(staticPath(d, url.pathname)), {
			headers: { "content-type": type, "cache-control": "no-cache" },
		}),
	);
}

/**
 * The capability. Four ways to show it, none of them from a frame that is not ours:
 *   the cookie (a browser that opened a link; never for a null origin, which holds no cookie of ours);
 *   `?k=` on a page or evidence GET (a link: the page load sets the cookie and drops the key from the address);
 *   the page key in the header, FROM THE PAGE'S OWN ORIGIN;
 *   the header with anything else: the page key from an inline frame or from a request with no Origin at all (curl, an agent), or the
 *   view key (the weak secret a Decisions post carries) from anywhere. Those get inline authority only: inlineVerdict, nothing more.
 * `full` is the first three: everything the page can do. Without it a request is restricted.
 */
export function capabilityProof(d: AppDeps, req: Request, url: URL, gate: Gate) {
	const { inline, sameOrigin } = gate;
	const headerKey = req.headers.get(TOKEN_HEADER);
	const byPageKeyHeader = d.capability.accepts(headerKey);
	const byViewKey = !byPageKeyHeader && d.capability.acceptsView(headerKey);
	// A cookie reaches an item's evidence only from the page's own origin (or a direct navigation): another PORT on the same host is "same-site", not
	// "same-origin", and must not be able to embed the evidence images with the owner's cookie. The header and ?k= are explicit and unaffected.
	const fetchSite = req.headers.get("sec-fetch-site");
	const cookieOk = !url.pathname.startsWith("/evidence/") || fetchSite === "same-origin" || fetchSite === "none";
	const byCookie = !inline && cookieOk && d.capability.acceptsCookie(req.headers.get("cookie"));
	const linkable =
		req.method === "GET" &&
		!inline &&
		(isShell(url.pathname) || isOpen(url.pathname) || url.pathname.startsWith("/evidence/"));
	const linkKey = url.searchParams.get(TOKEN_PARAM);
	const byLink = linkable && linkKey !== null && d.capability.accepts(linkKey);
	const full = byCookie || byLink || (byPageKeyHeader && sameOrigin);
	return { byPageKeyHeader, byViewKey, byCookie, byLink, full };
}

/**
 * Inline authority only: a null-origin frame, or a request whose only proof is a header and which has no cookie, no link and no own origin.
 * The same three reads and plain answer; anything else is refused whatever its path, so the key a post carries cannot read an item or its
 * evidence, answer a card or an approval, save a ruling or accept a batch. A refusal here is a 403, not a 401: the key is valid.
 * A null-origin frame's own page-key requests stay exactly as they were (refused for the API; its other GETs pass), except the /open route,
 * which a frame has no use for and which did not exist when that rule was written. The view key is held to the list on every path and from
 * every origin, evidence included.
 * The page's own static shell (`/`, `/rulings`, `/item/<id>`) carries no data and is served to the page key in a header, as it always was: a
 * browser loads it by navigation (cookie, or `?k=`), and a tool may fetch it. What the limit protects is the API, evidence and every write.
 * /open (a tap on a thread link) is the same kind of GET: a redirect to the thread's app link, which /api/queue already hands to an inline
 * frame (a card's `app`), so it adds nothing. A null-origin frame has no use for it, so only a request that is not one may.
 */
export function restrictedRefusal(
	req: Request,
	url: URL,
	proof: ReturnType<typeof capabilityProof>,
	inline: boolean,
): Response | undefined {
	const restricted = inline || !proof.full;
	const shellRead =
		req.method === "GET" && proof.byPageKeyHeader && (isShell(url.pathname) || (isOpen(url.pathname) && !inline));
	if (!restricted || shellRead || !(!inline || proof.byViewKey || isOpen(url.pathname))) return undefined;
	const v = inlineVerdict(req.method, url.pathname);
	if (v === "read" || v === "answer") return undefined;
	return withSecurity(
		fail(
			403,
			"refused: this key may read the queue, recent answers and rulings, and answer a question; the rest needs the page's own link",
		),
	);
}

/** A request with no valid key: a page load gets the static "needs its link" page, everything else a plain 401. */
export function unauthorized(req: Request, url: URL, allowed: boolean): Response {
	if (req.method === "GET" && isShell(url.pathname))
		return withSecurity(
			new Response(LOCKED_PAGE, {
				status: 401,
				headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
			}),
		);
	return locked(allowed);
}

/** A link: set the long-lived cookie and go to the same page without the key, so it is not left in the address bar or history. */
export function linkRedirect(d: AppDeps, req: Request, url: URL): Response {
	const clean = new URL(url);
	clean.searchParams.delete(TOKEN_PARAM);
	const secure = url.protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
	// A tapped `/open` link goes straight on to the thread's target instead (made from the path, never carrying the key).
	const onward = isOpen(url.pathname) && tapped(req) ? openTarget(d, url.pathname) : undefined;
	return withSecurity(
		new Response(null, {
			status: 303,
			headers: {
				location: typeof onward === "string" ? onward : `${clean.pathname}${clean.search}`,
				"set-cookie": d.capability.grant(secure),
				"cache-control": "no-store",
			},
		}),
	);
}

/** A cross-site form can't set this header or this content type, so a page elsewhere can't answer for the principal. */
export const postAllowed = (req: Request, g: Gate) =>
	req.headers.get("x-decision-queue") === "1" &&
	isJsonContentType(req.headers.get("content-type")) &&
	!(g.origin && !g.allowed && !g.sameOrigin);

/**
 * Where `/open/<server>/<threadId>` goes: made from the server name and thread id in the path, never taken from the request.
 * A string is the target; a Response is the refusal (a bad address, or no link for that thread).
 */
function openTarget(d: AppDeps, pathname: string): string | Response {
	const [, , rawServer, rawThread] = pathname.split("/");
	let server = "";
	let threadId = "";
	try {
		server = decodeURIComponent(rawServer ?? "");
		threadId = decodeURIComponent(rawThread ?? "");
	} catch {
		return fail(400, "bad thread address");
	}
	return d.links?.target(server, threadId) ?? fail(404, "no link for this thread");
}

/**
 * The `/open` route. A tap gets a 303 straight to the target, so the browser hands it to the app in the same navigation (no page, no
 * second tap). Anything else gets the page that goes on by itself and keeps a button to tap (./thread-links.ts `openPage`).
 */
function openThread(ctx: Ctx, pathname: string, tap: boolean): Response {
	const { d } = ctx;
	const target = openTarget(d, pathname);
	if (typeof target !== "string") return target;
	if (tap) return new Response(null, { status: 303, headers: { location: target, "cache-control": "no-store" } });
	const [, , rawServer, rawThread] = pathname.split("/");
	const server = decodeURIComponent(rawServer ?? "");
	const threadId = decodeURIComponent(rawThread ?? "");
	const title = d.mirror?.list().find((c) => c.server === server && c.threadId === threadId)?.threadTitle;
	return new Response(openPage(target, title ? `“${title}”` : "the thread"), {
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
	});
}

/** The pages and files behind the key: evidence, the open page, the app shell. */
export function servePage(ctx: Ctx, req: Request, url: URL): Response {
	if (req.method !== "GET") return withSecurity(fail(404, "not found"));
	if (url.pathname.startsWith("/evidence/")) return withSecurity(evidence(ctx, url));
	if (isOpen(url.pathname)) return withSecurity(openThread(ctx, url.pathname, tapped(req)));
	if (isShell(url.pathname))
		return withSecurity(
			new Response(Bun.file(staticPath(ctx.d, "/index.html")), {
				headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
			}),
		);
	return withSecurity(fail(404, "not found"));
}
