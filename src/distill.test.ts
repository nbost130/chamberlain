import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { saveDistillWeek } from "./core/distill/history.ts";
import type { DistillReport } from "./core/distill/report.ts";
import { distillSettings, distillWindow } from "./core/distill/window.ts";
import { askQuestion } from "./core/items/questions.ts";
import { obsPath, openObsDb } from "./core/obs/db.ts";
import { openStore } from "./core/store/sqlite-store.ts";
import { dbPath } from "./core/store/store.ts";
import { mk, refuses } from "./testing/ask-fixtures.ts";
import { useCoreMigrateFixtures } from "./testing/core-migrate-fixtures.ts";

const { world, put } = useCoreMigrateFixtures();
const fixtureText = "fixture secret must never be output";
const cli = new URL("./cli.ts", import.meta.url).pathname;

const envFor = ({ conf, state }: ReturnType<typeof world>) => ({
	...process.env,
	CHAMBERLAIN_CONF: conf,
	CHAMBERLAIN_STATE: state,
});

function run(w: ReturnType<typeof world>, ...argv: string[]) {
	const p = Bun.spawnSync([process.execPath, cli, "distill", ...argv], { env: envFor(w) });
	return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

test("asks validate optional repository scope without echoing invalid input", () => {
	expect(mk({ repo: "Example/Widget" }).repo).toBe("Example/Widget");
	expect(mk({})).not.toHaveProperty("repo");
	for (const repo of [null, 5, "", "example", "/widget", "example/..", "example/widget extra", "example/widget#5"])
		refuses({ repo }, '"repo" must be an owner/name repository');
});

test("the last complete week uses local Monday boundaries through daylight saving changes", () => {
	const zone = "America/New_York";
	const start = Date.parse("2026-03-02T05:00:00Z");
	const end = Date.parse("2026-03-09T04:00:00Z");
	expect(distillWindow(end, 7, zone)).toEqual({ week: "2026-03-02", span: { from: start, to: end } });
	expect(distillWindow(end + 86400_000, 7, zone)).toEqual(distillWindow(end, 7, zone));
	expect(distillWindow(end - 1, 7, zone).week).toBe("2026-02-23");
	expect(distillWindow(end, 1, zone)).toEqual({ span: { from: Date.parse("2026-03-08T05:00:00Z"), to: end } });
	expect(distillSettings(undefined)).toEqual({ timezone: "UTC", chat: false });
	expect(() => distillSettings({ timezone: "invalid-zone" })).toThrow("valid time zone");
	expect(() => distillSettings({ chat: "true" })).toThrow("must be true or false");
});

test("the CLI leaves the ledger and telemetry byte-identical and upserts just the weekly definition", () => {
	const w = world();
	const conf = `${w.conf}/config.json`;
	put(conf, JSON.stringify({ schemaVersion: 1, distill: { timezone: "UTC" } }));
	const ledger = dbPath(w.state);
	const obs = obsPath(w.state);
	const start = distillWindow(Date.now(), 7, "UTC").span.from;
	const q = mk({ title: fixtureText, context: fixtureText, secret: true, threadId: "fixture-source", options: [] });
	const store = openStore(ledger);
	askQuestion(store, q, start);
	store.close();
	openObsDb(obs).close();
	const before = [ledger, obs, conf].map((path) => readFileSync(path));

	const first = run(w, "--json");
	expect(first).toMatchObject({ code: 0, err: "" });
	const report = JSON.parse(first.out) as DistillReport;
	expect(report).toMatchObject({ definitionVersion: 1, escalations: 1, unplaced: 1, chatStatus: "off" });
	saveDistillWeek(w.state, { ...report, definitionVersion: 0, escalations: 42 });
	saveDistillWeek(w.state, { ...report, escalations: 77 });
	const again = run(w, "--days", "7", "--json");
	expect(again).toEqual(first);
	const plain = run(w);
	expect(plain).toMatchObject({ code: 0, err: "" });
	expect(plain.out).toContain("Escalations: 1");
	expect(first.out + plain.out).not.toContain(fixtureText);
	const history = new Database(`${w.state}/distill.db`, { readonly: true });
	try {
		expect(history.query("SELECT version FROM migrations").all()).toEqual([{ version: 22 }]);
		const rows = history
			.query("SELECT week_start, definition_version, report FROM distill_weekly ORDER BY definition_version")
			.all();
		expect(rows).toEqual([
			{
				week_start: report.week,
				definition_version: 0,
				report: JSON.stringify({ ...report, definitionVersion: 0, escalations: 42 }),
			},
			{ week_start: report.week, definition_version: 1, report: JSON.stringify(report) },
		]);
		expect(JSON.stringify(rows)).not.toContain(fixtureText);
	} finally {
		history.close();
	}
	expect([ledger, obs, conf].map((path) => readFileSync(path))).toEqual(before);
});

test("ad hoc reports do not create a history database, and invalid arguments and missing ledger refuse quietly", () => {
	const w = world();
	expect(run(w, "--days", "0")).toEqual({ code: 1, out: "", err: "usage: distill [--days N] [--json]\n" });
	expect(run(w, fixtureText).err).not.toContain(fixtureText);
	expect(run(w).code).toBe(1);
	expect(existsSync(dbPath(w.state))).toBe(false);
	openStore(dbPath(w.state)).close();
	expect(run(w, "--days", "3", "--json")).toMatchObject({ code: 0, err: "" });
	expect(existsSync(`${w.state}/distill.db`)).toBe(false);
});

test("the opted-in CLI reports a local T3 count and drops message text", async () => {
	const w = world();
	const start = distillWindow(Date.now(), 7, "UTC").span.from;
	const calls: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			calls.push(new URL(request.url).pathname);
			const item = {
				type: "user_message",
				createdBy: "user",
				updatedAt: new Date(start).toISOString(),
				text: fixtureText,
			};
			return Response.json({
				projection: {
					turnItems: [
						{ ...item, id: "fixture-person", creationSource: "web" },
						{ ...item, id: "fixture-machine", creationSource: "server" },
					],
				},
				hasMoreHistory: false,
			});
		},
	});
	try {
		const config = {
			schemaVersion: 1,
			threads: { steward: "fixture-steward" },
			servers: [{ name: "local", origin: server.url.origin, tokenFile: "fixture-read" }],
		};
		const path = `${w.conf}/config.json`;
		put(path, JSON.stringify(config));
		mkdirSync(`${w.conf}/secrets`, { mode: 0o700 });
		put(`${w.conf}/secrets/fixture-read`, "test credential");
		openStore(dbPath(w.state)).close();
		expect(JSON.parse(run(w, "--json").out)).toMatchObject({ chatStatus: "off" });
		expect(calls).toEqual([]);
		put(path, JSON.stringify({ ...config, distill: { chat: true } }));
		const p = Bun.spawn([process.execPath, cli, "distill", "--json"], { env: envFor(w), stderr: "pipe" });
		const [out, err, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		expect(code).toBe(0);
		expect(err).toBe("");
		expect(JSON.parse(out)).toMatchObject({ chatStatus: "ok", chatRedirections: 1, corrections: 0 });
		expect(out).not.toContain(fixtureText);
		expect(calls).toEqual(["/api/orchestration/threads/fixture-steward/bounded"]);
		const db = new Database(`${w.state}/distill.db`, { readonly: true });
		try {
			expect(db.query("SELECT report FROM distill_weekly").get()).toEqual({ report: JSON.stringify(JSON.parse(out)) });
		} finally {
			db.close();
		}
	} finally {
		server.stop(true);
	}
});
