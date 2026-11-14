import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { conformance, has } from "../core/adapter.ts";
import { adapterEntry, adapterNames, makeAdapter, loadServers } from "./index.ts";
import { t3Server } from "./t3/server.ts";
import { postWebhook, webhookWake } from "./t3/wake.ts";

const server = { name: "main", adapter: "t3", origin: "http://127.0.0.1:3773", tokenFile: "read-token" };

describe("the T3 adapter", () => {
	test("it is registered, declares what it implements and implements what it declares", () => {
		expect(adapterNames()).toContain("t3");
		const a = makeAdapter(server);
		expect(conformance(a)).toEqual([]);
		expect(a.id).toBe("t3");
		for (const cap of [
			"answer",
			"listWaiting",
			"setTitle",
			"transcriptPath",
			"inspect",
			"send",
			"stewardProbe",
			"compact",
			"snapshot",
		] as const)
			expect(has(a, cap)).toBe(true);
	});
	test("a server it serves needs an origin and a token file", () => {
		expect(t3Server(server).origin).toBe("http://127.0.0.1:3773");
		expect(() => t3Server({ name: "x", adapter: "t3", origin: "http://x" })).toThrow(
			"a t3 server needs origin and tokenFile",
		);
		expect(() => makeAdapter({ name: "x", adapter: "t3" })).toThrow("needs origin and tokenFile");
	});
	test("an unknown adapter name is refused with the registered ones listed", () => {
		expect(() => adapterEntry("nope")).toThrow('unknown adapter "nope" (registered: t3');
		expect(() => adapterEntry("__proto__")).toThrow("unknown adapter");
	});
	test("with no servers.json there is one T3 server named local", () => {
		const conf = mkdtempSync(`${tmpdir()}/chamberlain-reg-`);
		expect(loadServers(conf)).toMatchObject([{ name: "local", adapter: "t3", tokenFile: "read-token" }]);
	});
	test("its wake posts {deliveryId, message} to the webhook, and is ready only when the URL file is there", async () => {
		const conf = mkdtempSync(`${tmpdir()}/chamberlain-wake-`);
		const a = makeAdapter(server, { conf, state: conf });
		expect(a.wake.ready()).toBe(false);
		writeFileSync(`${conf}/wake-url`, "http://hook.test/wake\n", { mode: 0o600 });
		expect(a.wake.ready()).toBe(true);
		const seen: { url: string; body: unknown }[] = [];
		const stub = (async (url: string, init: RequestInit) => {
			seen.push({ url, body: JSON.parse(String(init.body)) });
			return new Response(null, { status: 202 });
		}) as unknown as typeof fetch;
		const r = await webhookWake(() => "http://hook.test/wake", stub).send("d-1", "hello");
		expect(r).toEqual({ ok: true, status: 202 });
		expect(seen).toEqual([{ url: "http://hook.test/wake", body: { deliveryId: "d-1", message: "hello" } }]);
		expect(
			await postWebhook(
				"http://hook.test/wake",
				"d-2",
				"x",
				(async () => new Response(null, { status: 503 })) as unknown as typeof fetch,
			),
		).toEqual({ ok: false, status: 503 });
	});
	test("isBusy is idle with no Steward thread, and unknown when its state database can't be read", () => {
		const conf = mkdtempSync(`${tmpdir()}/chamberlain-busy-`);
		const prior = process.env.CHAMBERLAIN_T3_STATE_DB;
		process.env.CHAMBERLAIN_T3_STATE_DB = `${conf}/none.sqlite`;
		try {
			const a = makeAdapter(server, { conf, state: conf });
			expect(a.isBusy()).toBe("idle");
			writeFileSync(`${conf}/steward-thread`, "steward-1\n", { mode: 0o600 });
			expect(a.isBusy()).toBe("unknown");
		} finally {
			if (prior === undefined) delete process.env.CHAMBERLAIN_T3_STATE_DB;
			else process.env.CHAMBERLAIN_T3_STATE_DB = prior;
		}
	});
});
