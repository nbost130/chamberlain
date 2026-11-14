/**
 * Test doubles for the wake transport (`WakeTransport` in src/core/deliver.ts), so core tests never need an adapter.
 */
import type { WakeTransport } from "../core/deliver.ts";

/**
 * A webhook-shaped transport over a `fetch` function: POSTs `{deliveryId, message}` to the URL and counts a 2xx as
 * accepted. Core tests give it a stub `fetch` that records what arrived and answers with any status.
 */
export function fetchWake(url: () => string | undefined, doFetch: typeof fetch): WakeTransport {
	return {
		ready: () => Boolean(url()),
		send: async (deliveryId, message) => {
			const r = await doFetch(url()!, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ deliveryId, message }),
				signal: AbortSignal.timeout(15000),
			});
			return { ok: r.ok, status: r.status };
		},
	};
}

/** A transport that records every accepted wake and answers with a status you can change. */
export function recordingWake(status: () => number = () => 202) {
	const accepted: { deliveryId: string; message: string }[] = [];
	let code = status;
	const wake: WakeTransport = {
		ready: () => true,
		send: async (deliveryId, message) => {
			const s = code();
			if (s < 300) accepted.push({ deliveryId, message });
			return { ok: s < 300, status: s };
		},
	};
	return {
		wake,
		accepted,
		setStatus: (f: () => number) => {
			code = f;
		},
	};
}
