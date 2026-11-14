/**
 * How a wake reaches a T3 thread: a POST of `{deliveryId, message}` to the webhook of a scheduled task bound to the
 * thread. The webhook cannot de-duplicate, so the daemon's relay (core) sends each outbox row under its one frozen delivery id.
 */
import type { WakeTransport } from "../../core/deliver.ts";

/** One POST to a thread-bound webhook, with a 15 second deadline. `ok` is a 2xx; anything else, or a throw, is an attempt that did not deliver. */
export async function postWebhook(url: string, deliveryId: string, message: string, doFetch: typeof fetch = fetch) {
	const r = await doFetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ deliveryId, message }),
		signal: AbortSignal.timeout(15000),
	});
	return { ok: r.ok, status: r.status };
}

/** The wake transport for a webhook URL, read fresh on every call. Undefined means nowhere to deliver. */
export const webhookWake = (url: () => string | undefined, doFetch: typeof fetch = fetch): WakeTransport => ({
	ready: () => Boolean(url()),
	send: async (deliveryId, message) => {
		const target = url();
		if (!target) throw Error("webhook wake: send called with no webhook URL (ready() was false)");
		return postWebhook(target, deliveryId, message, doFetch);
	},
});
