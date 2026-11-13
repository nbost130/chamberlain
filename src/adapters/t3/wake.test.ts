/**
 * What the webhook transport tells the relay. Every outcome is one counted attempt, so the transport only has to say whether the webhook
 * accepted the POST; a network failure is thrown and the relay counts it like any other attempt that did not deliver.
 */
import { describe, expect, test } from "bun:test";
import { postWebhook } from "./wake.ts";

const answer = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch;

describe("postWebhook", () => {
	test("a 2xx is accepted", async () => { expect(await postWebhook("http://h/x", "id", "m", answer(202))).toEqual({ ok: true, status: 202 }); });
	test("any other HTTP answer is not accepted, and says its status", async () => { expect(await postWebhook("http://h/x", "id", "m", answer(503))).toEqual({ ok: false, status: 503 }); });
	test("a network failure or a timeout is thrown", async () => {
		await expect(postWebhook("http://h/x", "id", "m", (async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); }) as unknown as typeof fetch)).rejects.toThrow();
	});
	test("it posts the delivery id and the message as JSON", async () => {
		let body: unknown;
		await postWebhook("http://h/x", "the-id", "the text", (async (_u: string, init: RequestInit) => { body = JSON.parse(String(init.body)); return new Response(null, { status: 200 }); }) as unknown as typeof fetch);
		expect(body).toEqual({ deliveryId: "the-id", message: "the text" });
	});
});
