import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { cfg, NOW, no, thread } from "../../testing/core-classifier-classify-fixtures.ts";
import { memStore } from "../../testing/store.ts";
import { classifyIdle } from "./classify.ts";
import { USAGE_KEY } from "./classify-budget.ts";

const clean: (() => void)[] = [];
afterEach(() => {
	for (const c of clean.splice(0)) c();
});

test("configured HTTP classifier switches models, redacts text and accounts quota failures without acting", async () => {
	const conf = mkdtempSync(`${tmpdir()}/classifier-model-`);
	clean.push(() => rmSync(conf, { recursive: true, force: true }));
	const bodies: any[] = [];
	let status = 200;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(r) {
			bodies.push(await r.json());
			return Response.json(
				{ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(no) } }] },
				{ status },
			);
		},
	});
	clean.push(() => server.stop(true));
	const save = (model: string) =>
		writeFileSync(
			`${conf}/config.json`,
			JSON.stringify({
				models: { classifier: { adapter: "openai-chat", endpoint: server.url.href, model, accountingUsdPerCall: 0.1 } },
			}),
			{ mode: 0o600 },
		);
	const store = memStore();
	const logs: unknown[] = [];
	const d = { store, conf, now: NOW, log: (_event: string, data?: unknown) => logs.push(data) };
	const c = cfg({ provider: "model", budget: { maxPerRun: 20, maxCallsPerDay: 500, maxUsdPerDay: 0.3 } });
	const t = thread("same", { lastMessage: "Contact test@example.com" });
	save("first");
	await classifyIdle([t], c, d);
	save("second");
	await classifyIdle([t], c, d);
	expect(bodies.map((b) => b.model)).toEqual(["first", "second"]);
	expect(JSON.stringify(bodies)).not.toContain("test@example.com");
	status = 429;
	const failed = await classifyIdle([thread("failed")], c, d);
	expect(failed.get("main:failed:h-failed")?.action).toBe("unknown");
	expect(store.state.get<{ usd: number }>(USAGE_KEY)?.usd).toBeCloseTo(0.3);
	await classifyIdle([thread("held")], c, d);
	expect(bodies).toHaveLength(3);
	expect(JSON.stringify(logs)).not.toContain("test@example.com");
});
