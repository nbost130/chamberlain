import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { configureThread } from "./adapters/t3/model.ts";
import { importThreadModels } from "./core/config/config-migrate.ts";
import { cfg } from "./core/config/layout.ts";
import { adoptThreadModels } from "./models.ts";
import { modelServer } from "./testing/model-server.ts";

const servers: ReturnType<typeof modelServer>[] = [];
afterEach(() => {
	for (const s of servers.splice(0)) s.close();
});

test("one-time import preserves actual selections and never replaces an explicit disabled role", async () => {
	const s = modelServer();
	servers.push(s);
	await configureThread(s.conf, "decisions");
	writeFileSync(`${s.conf}/config.json`, JSON.stringify({ ...s.config, models: { desk: null } }), { mode: 0o600 });
	const before = readFileSync(`${s.conf}/config.json`, "utf8");
	expect(await adoptThreadModels(s.conf, "test", true)).toEqual(["steward", "decisions"]);
	expect(readFileSync(`${s.conf}/config.json`, "utf8")).toBe(before);
	expect(await adoptThreadModels(s.conf, "test")).toEqual(["steward", "decisions"]);
	expect(cfg(s.conf, "models")).toMatchObject({ decisions: s.config.models.decisions, desk: null });
	expect(await adoptThreadModels(s.conf, "test")).toEqual([]);
	expect(s.sent()).toBe("");
});

test("top-level models null disables import without contacting a provider or reporting imported roles", async () => {
	const s = modelServer();
	servers.push(s);
	writeFileSync(`${s.conf}/config.json`, JSON.stringify({ ...s.config, models: null }), { mode: 0o600 });
	const before = readFileSync(`${s.conf}/config.json`, "utf8");
	for (const dryRun of [true, false]) expect(await adoptThreadModels(s.conf, "unavailable-server", dryRun)).toEqual([]);
	expect(readFileSync(`${s.conf}/config.json`, "utf8")).toBe(before);
	expect(s.requests).toHaveLength(0);
});

test("the locked importer reports only selections it actually writes after an operator disables a role", () => {
	const s = modelServer();
	servers.push(s);
	const candidate = {
		decisions: {
			threadId: s.config.threads.decisions,
			model: {
				adapter: "t3" as const,
				server: "test",
				instanceId: "other-provider",
				model: "chosen-model",
				options: {},
			},
		},
	};
	for (const models of [null, { decisions: null }]) {
		writeFileSync(`${s.conf}/config.json`, JSON.stringify({ ...s.config, models }), { mode: 0o600 });
		expect(importThreadModels(s.conf, candidate)).toEqual([]);
		expect(JSON.parse(readFileSync(`${s.conf}/config.json`, "utf8")).models).toEqual(models);
	}
	writeFileSync(`${s.conf}/config.json`, JSON.stringify({ ...s.config, models: {} }), { mode: 0o600 });
	expect(importThreadModels(s.conf, candidate)).toEqual(["decisions"]);
	expect(cfg(s.conf, "models")).toMatchObject({ decisions: candidate.decisions.model });
});
