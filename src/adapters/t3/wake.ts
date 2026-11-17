/**
 * How a wake reaches a T3 thread: a POST of `{deliveryId, message}` to the webhook of a scheduled task bound to the
 * thread. The webhook cannot de-duplicate, so the daemon's relay (core) sends each outbox row under its one frozen delivery id.
 */
import type { WakeTransport } from "../../core/delivery/deliver.ts";

const ERRNO = /^[A-Z_]+$/;

/** A fixed error class for a thrown fetch failure: never the exception text (it may name the webhook URL). */
function transportClass(e: unknown): string {
	if (isTimeout(e)) return "timeout";
	if (isAborted(e)) return "aborted";
	const code = errnoOf(e);
	if (code) return `network:${code}`;
	return "unknown";
}

function isTimeout(e: unknown): boolean {
	if (!e || typeof e !== "object") return false;
	const name = "name" in e ? String((e as { name: unknown }).name) : "";
	if (name === "TimeoutError") return true;
	return "cause" in e && isTimeout((e as { cause: unknown }).cause);
}

function isAborted(e: unknown): boolean {
	if (!e || typeof e !== "object") return false;
	return ("name" in e ? String((e as { name: unknown }).name) : "") === "AbortError";
}

/** `e.cause?.code` when it is an errno-shaped token; otherwise the same on `e` itself (some stubs put it there). */
function errnoOf(e: unknown): string | undefined {
	for (const c of [causeOf(e), e]) {
		if (!c || typeof c !== "object" || !("code" in c)) continue;
		const code = (c as { code: unknown }).code;
		if (typeof code === "string" && ERRNO.test(code)) return code;
	}
	return undefined;
}

function causeOf(e: unknown): unknown {
	return e && typeof e === "object" && "cause" in e ? (e as { cause: unknown }).cause : undefined;
}

/** One POST to a thread-bound webhook, with a 15 second deadline. `ok` is a 2xx; anything else, or a throw, is an attempt that did not deliver. */
export async function postWebhook(url: string, deliveryId: string, message: string, doFetch: typeof fetch = fetch) {
	try {
		const r = await doFetch(url, {
			method: "POST",
			redirect: "error",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ deliveryId, message }),
			signal: AbortSignal.timeout(15000),
		});
		return { ok: r.ok, status: r.status };
	} catch (e) {
		return { ok: false, error: transportClass(e) };
	}
}

/** The wake transport for a webhook URL, read fresh on every call. Undefined means nowhere to deliver. */
export const webhookWake = (url: () => string | undefined, doFetch: typeof fetch = fetch): WakeTransport => ({
	ready: () => Boolean(url()),
	target: url,
	send: async (deliveryId, message, opts) => {
		const target = opts?.target ?? url();
		if (!target) throw Error("webhook wake: send called with no webhook URL (ready() was false)");
		return postWebhook(target, deliveryId, message, doFetch);
	},
});
