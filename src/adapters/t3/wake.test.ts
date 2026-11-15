/**
 * What the webhook transport tells the relay. Every outcome is one counted attempt; a network failure is a fixed error
 * class, never the exception text (which may name the webhook URL).
 */
import { describe, expect, test } from "bun:test";
import { postWebhook } from "./wake.ts";

const answer = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch;

describe("postWebhook", () => {
	test("a 2xx is accepted", async () => {
		expect(await postWebhook("http://h/x", "id", "m", answer(202))).toEqual({ ok: true, status: 202 });
	});
	test("any other HTTP answer is not accepted, and says its status", async () => {
		expect(await postWebhook("http://h/x", "id", "m", answer(503))).toEqual({ ok: false, status: 503 });
	});
	test("a network failure is a fixed class, never thrown", async () => {
		expect(
			await postWebhook("http://h/x", "id", "m", (async () => {
				throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
			}) as unknown as typeof fetch),
		).toEqual({ ok: false, error: "network:ECONNREFUSED" });
	});
	test("a TimeoutError is timeout; an AbortError is aborted", async () => {
		expect(
			await postWebhook("http://h/x", "id", "m", (async () => {
				throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
			}) as unknown as typeof fetch),
		).toEqual({ ok: false, error: "timeout" });
		expect(
			await postWebhook("http://h/x", "id", "m", (async () => {
				throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
			}) as unknown as typeof fetch),
		).toEqual({ ok: false, error: "aborted" });
	});
	test("it posts the delivery id and the message as JSON", async () => {
		let body: unknown;
		await postWebhook("http://h/x", "the-id", "the text", (async (_u: string, init: RequestInit) => {
			body = JSON.parse(String(init.body));
			return new Response(null, { status: 200 });
		}) as unknown as typeof fetch);
		expect(body).toEqual({ deliveryId: "the-id", message: "the text" });
	});
});
