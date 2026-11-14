/** The page's response helpers, its security headers, and which requests an inline frame may make. */
import { TOKEN_HEADER } from "../core/capability.ts";

/**
 * Is this Content-Type the JSON media type? The media type is the part before the first ";" and must be exactly `application/json`
 * (type and subtype are case-insensitive, RFC 9110 section 8.3.1), optionally followed by parameters such as `charset=utf-8`.
 * A prefix match is wrong: `application/jsonxxx` and `application/json-seq` are other types. Part of the cross-site guard on every POST.
 */
export const isJsonContentType = (value: string | null | undefined): boolean =>
	((value ?? "").split(";", 1)[0] ?? "").trim().toLowerCase() === "application/json";
export const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
export const fail = (status: number, error: string) => json({ error }, status);
const SECURITY = {
	"content-security-policy":
		"default-src 'self'; img-src 'self'; media-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};
export const withSecurity = (r: Response) => {
	for (const [k, v] of Object.entries(SECURITY)) r.headers.set(k, v);
	return r;
};
/**
 * What an inline frame (a request whose origin is exactly "null") may do, and nothing else. Enforced here, on the server, on the
 * route AND on the request's fields: the page's own script is not what is trusted, the request is.
 *   - GET /api/queue, /api/recent, /api/rulings;
 *   - POST /api/items/<id>/answer with `choice` and an optional `note` and no other field.
 * Not a ruling field (saveRuling, rulingWording), not a card or an approval (those are answered on the full page, behind a
 * confirmation challenge), not an item's own read, not a ruling change, not a batch accept.
 */
const INLINE_READS = new Set(["/api/queue", "/api/recent", "/api/rulings"]);
const INLINE_ANSWER = /^\/api\/items\/Q-[a-z0-9]{4,16}\/answer$/;
export const INLINE_ANSWER_FIELDS = new Set(["choice", "note"]);
/** Pure: the verdict on a request from an inline frame, by method and path. */
export function inlineVerdict(
	method: string,
	pathname: string,
): "read" | "answer" | "preflight-read" | "preflight-answer" | "refuse" {
	if (method === "GET") return INLINE_READS.has(pathname) ? "read" : "refuse";
	if (method === "POST") return INLINE_ANSWER.test(pathname) ? "answer" : "refuse";
	if (method === "OPTIONS")
		return INLINE_READS.has(pathname) ? "preflight-read" : INLINE_ANSWER.test(pathname) ? "preflight-answer" : "refuse";
	return "refuse";
}
/** CORS for T3's inline frames (origin "null"), on INLINE_API only. */
export const inlineCors = (r: Response) => {
	r.headers.set("access-control-allow-origin", "null");
	r.headers.set("access-control-allow-methods", "GET, POST");
	r.headers.set("access-control-allow-headers", `content-type, x-decision-queue, ${TOKEN_HEADER}`);
	r.headers.set("access-control-allow-private-network", "true");
	r.headers.set("access-control-max-age", "600");
	r.headers.set("vary", "origin");
	return r;
};
