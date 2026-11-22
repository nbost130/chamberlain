import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { migrateLayout } from "../config/config-migrate.ts";
import { readConfigFile } from "../config/layout-read.ts";
import { parseConfigDoc } from "../config/layout-schema.ts";
import { MIGRATIONS } from "../store/migrations.ts";
import { readModel, selectedReader } from "./reader.ts";
import { parseModels } from "./selection.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const fn of cleanups.splice(0)) fn();
});
function directory() {
	const dir = mkdtempSync(`${tmpdir()}/model-config-`);
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("selection is explicit, with strict role and transport capability validation", () => {
	expect(parseModels(undefined)).toEqual({});
	for (const selection of [
		{ adapter: "other", model: "x" },
		{ adapter: "claude-cli", model: "x" },
		{ adapter: "openai-chat", model: "x", endpoint: "http://remote.example" },
		{ adapter: "openai-chat", model: "x", endpoint: "https://example.com?token=unsafe" },
	])
		expect(() => parseConfigDoc({ models: { classifier: selection } })).toThrow();
	expect(() => parseModels({ decisions: { adapter: "openai-chat", model: "x" } })).toThrow();
	expect(() => selectedReader(directory(), "classifier")).toThrow("explicit");
});

test("HTTP reader uses the chosen model and effort, with no tool capabilities; quota errors never fallback", async () => {
	const calls: any[] = [];
	let status = 200;
	let finish = "stop";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const body = await req.json();
			calls.push(body);
			return Response.json(
				status === 200
					? {
							model: "reported",
							choices: [{ finish_reason: finish, message: { content: "answer" } }],
							usage: { prompt_tokens: 12 },
						}
					: { error: "PRIVATE INPUT MUST NOT ESCAPE" },
				{ status },
			);
		},
	});
	cleanups.push(() => server.stop(true));
	const conf = directory();
	const save = (model: string) =>
		writeFileSync(
			`${conf}/config.json`,
			JSON.stringify({
				models: { classifier: { adapter: "openai-chat", endpoint: server.url.href, model, effort: "high" } },
			}),
			{ mode: 0o600 },
		);
	save("first");
	expect(
		await readModel(selectedReader(conf, "classifier"), { system: "classify", text: "private input" }, conf),
	).toMatchObject({ text: "answer", inputTokens: 12 });
	save("replacement");
	await readModel(selectedReader(conf, "classifier"), { system: "classify", text: "private input" }, conf);
	expect(calls.map((c) => c.model)).toEqual(["first", "replacement"]);
	expect(calls[0]).toMatchObject({ reasoning_effort: "high" });
	expect(calls[0].tools).toBeUndefined();
	status = 429;
	await expect(readModel(selectedReader(conf, "classifier"), { system: "x", text: "private" }, conf)).rejects.toThrow(
		"HTTP 429",
	);
	expect(calls.length).toBe(3);
	status = 200;
	finish = "tool_calls";
	await expect(readModel(selectedReader(conf, "classifier"), { system: "x", text: "private" }, conf)).rejects.toThrow(
		"requested tools",
	);
});

test("missing configured credentials prevent the HTTP request", async () => {
	const conf = directory();
	mkdirSync(`${conf}/secrets`, { mode: 0o700 });
	const selection = parseModels({
		classifier: { adapter: "openai-chat", model: "chosen", endpoint: "http://127.0.0.1:1", keyFile: "absent" },
	}).classifier!;
	await expect(readModel(selection, { system: "x", text: "private" }, conf)).rejects.toThrow("credentials unavailable");
});

test("the existing migration moves explicit legacy selections once and preserves central choices", () => {
	const conf = directory();
	const chosen = { adapter: "openai-chat", endpoint: "http://localhost:5000/v1/chat/completions", model: "chosen" };
	writeFileSync(
		`${conf}/config.json`,
		JSON.stringify({
			models: { classifier: chosen },
			sweep: {
				idleParents: {
					classifier: {
						provider: "haiku",
						allowTextToLeaveMachine: true,
						haiku: { command: "old-cli", model: "old-model" },
					},
				},
			},
			mail: { models: { command: "explicit-cli", driver: "small", escalate: "large", top: "none" } },
		}),
		{ mode: 0o600 },
	);
	expect(migrateLayout(conf).changed).toBe(true);
	const doc = readConfigFile(conf) as any;
	expect(doc.models.classifier).toEqual(chosen);
	expect(doc.sweep.idleParents.classifier.provider).toBe("model");
	expect(doc.sweep.idleParents.classifier.haiku).toBeUndefined();
	expect(doc.mail.models).toBeUndefined();
	expect(doc.models.mailDriver.model).toBe("small");
	expect(migrateLayout(conf).changed).toBe(false);
});

test("database migration preserves classifier history and admits generic model providers", () => {
	const db = new Database(":memory:");
	try {
		for (const m of MIGRATIONS.filter((m) => m.version < 19)) db.exec(m.sql);
		db.run("INSERT INTO prepare_pr_links (thread_id,run_id,repo,started_at) VALUES ('thread','run','repo',1)");
		db.run(
			"INSERT INTO thread_dispositions (server,thread_id,message_hash,bank_version,classified_at,provider,mode,action,idle_minutes) VALUES ('s','t','h','b',1,'haiku','shadow','ignore',2)",
		);
		const before = db.query("SELECT * FROM thread_dispositions").all();
		const links = db.query("SELECT * FROM prepare_pr_links").all();
		db.exec(MIGRATIONS.find((m) => m.version === 19)!.sql);
		expect(db.query("SELECT * FROM thread_dispositions").all()).toEqual(before);
		expect(db.query("SELECT * FROM prepare_pr_links").all()).toEqual(links);
		db.run("UPDATE thread_dispositions SET provider='model'");
		expect(() => db.run("UPDATE thread_dispositions SET action='unknown'")).toThrow();
	} finally {
		db.close();
	}
});
