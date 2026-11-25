import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseAsk } from "./ask-parse.ts";
import { parseIdeas } from "./core/config/ideas-config.ts";
import { ideaCapProblem } from "./core/items/ideas.ts";
import { askQuestion, QUEUE, type Question, questionStates } from "./core/items/questions.ts";
import { claimWake, pageClaim } from "./core/items/questions-claim.ts";
import { answerDeliveryId, plainAnswer } from "./core/items/questions-wake.ts";
import { snoozeQuestion } from "./core/items/snooze.ts";
import { openStore } from "./core/store/sqlite-store.ts";
import { dbPath } from "./core/store/store.ts";
import { memStore } from "./testing/store.ts";

const DAY = 86_400_000;
const RAW = {
	kind: "idea",
	title: "Cache rendered thumbnails",
	context: "- Cost: one day\n- Evidence: repeat renders dominate the profile",
	options: ["File an issue", "Decline"],
	recommended: 0,
	thread: "Media processing",
	server: "primary",
	threadId: "thread-test",
};
const roots: string[] = [];
const stores: ReturnType<typeof openStore>[] = [];
afterEach(() => {
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function rig(ideas: Record<string, unknown> = {}) {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-ideas-`);
	roots.push(root);
	const conf = `${root}/conf`;
	const state = `${root}/state`;
	mkdirSync(conf, { mode: 0o700 });
	writeFileSync(`${conf}/config.json`, JSON.stringify({ schemaVersion: 1, ideas }), { mode: 0o600 });
	return {
		store: () => {
			const store = openStore(dbPath(state));
			stores.push(store);
			return store;
		},
		run: async (command: string, args: string[]) => {
			const child = Bun.spawn([process.execPath, new URL(command, import.meta.url).pathname, ...args], {
				env: { ...process.env, HOME: root, CHAMBERLAIN_CONF: conf, CHAMBERLAIN_STATE: state },
				stdout: "pipe",
				stderr: "pipe",
			});
			const [status, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			return { status, stdout, stderr };
		},
	};
}

const file = (r: ReturnType<typeof rig>, over = {}) => r.run("./ask.ts", [JSON.stringify({ ...RAW, ...over })]);

test("ideas default to silent, can be explicitly silent, and refuse urgency, approval tags and missing details", async () => {
	const r = rig({ perThreadDailyCap: 2 });
	const store = r.store();
	for (const over of [{}, { urgent: false, title: "Deduplicate filter presets" }]) {
		// A post attempt would fail against this intentionally unconfigured adapter and could not exit 0.
		expect(await file(r, over)).toMatchObject({
			status: 0,
			stdout: expect.stringContaining("not urgent: no notification sent"),
			stderr: "",
		});
	}
	for (const [over, reason] of [
		[{ urgent: true }, "cannot be urgent"],
		[{ tag: "Approval" }, "cannot be an approval"],
		[{ recommended: null }, "needs a recommended option"],
		[{ context: "Cost: one hour" }, "must include Evidence:"],
		[{ context: "Cost:   \nEvidence: test results" }, "must include Cost:"],
	] as const) {
		const refused = await file(r, over);
		expect(refused.status).not.toBe(0);
		expect(refused.stderr).toContain(reason);
	}
	const states = [...questionStates(store).values()];
	expect(states).toHaveLength(2);
	expect(states.every((q) => q.urgent === false)).toBe(true);
	expect(store.wakes.rows("all")).toEqual([]);
	expect(store.wakes.held()).toEqual([]);
	expect(await r.run("./core/ops/afk.ts", ["hold", RAW.thread, RAW.title, "--item", states[0]!.id])).toMatchObject({
		status: 2,
		stderr: expect.stringContaining("is an idea"),
	});
});

test("the default per-thread cap follows a renamed thread and the overall cap counts a closed filing", async () => {
	const r = rig();
	const store = r.store();
	expect((await file(r)).status).toBe(0);
	const [old] = questionStates(store).values();
	store.items.resolve(QUEUE, old!.id, Date.now());
	expect(await file(r, { title: "Document audio presets", thread: "Renamed" })).toMatchObject({
		status: 2,
		stderr: expect.stringContaining("per-thread daily idea cap"),
	});
	expect((await file(r, { title: "Document audio presets", threadId: "thread-other" })).status).toBe(0);
	expect(await file(r, { threadId: "thread-third" })).toMatchObject({
		status: 2,
		stderr: expect.stringContaining("daily idea cap"),
	});
	expect(questionStates(store).size).toBe(2);
});

function seed(store: ReturnType<typeof openStore>, id: string, at: number, over: Partial<Question> = {}) {
	const idea = { ...parseAsk(RAW, id, new Date(at).toISOString()), ...over };
	askQuestion(store, idea, at);
	return idea;
}

test("a snoozed idea occupies an open slot until it closes", async () => {
	const r = rig({ openCap: 1 });
	const store = r.store();
	const now = Date.now();
	const old = seed(store, "Q-old1", now - 2 * DAY, { title: "Generate audio presets" });
	snoozeQuestion(store, old.id, new Date(now + DAY).toISOString(), now);
	expect(await file(r)).toMatchObject({ status: 2, stderr: expect.stringContaining("open idea cap (1)") });
	expect(questionStates(store).size).toBe(1);
	store.items.resolve(QUEUE, old.id, now);
	expect((await file(r)).status).toBe(0);
});

test("both daily caps reset at midnight in the configured zone, including after a DST transition", () => {
	const store = memStore();
	const before = Date.parse("2026-03-09T06:59:00Z");
	const old = seed(store, "Q-old1", before);
	for (const caps of [{ dailyCap: 1 }, { perThreadDailyCap: 1 }]) {
		const config = parseIdeas({ timeZone: "America/Los_Angeles", ...caps });
		expect(ideaCapProblem(store, old, config, before + 30_000)).toContain("daily idea cap");
		expect(ideaCapProblem(store, old, config, before + 60_000)).toBeUndefined();
	}
	expect(() => parseIdeas({ timeZone: "Invalid/Zone" })).toThrow("IANA time zone");
});

test("two concurrent CLI asks for one remaining slot produce one filing and one cap refusal", async () => {
	const r = rig({ dailyCap: 1 });
	const store = r.store();
	const results = await Promise.all([file(r), file(r, { title: "Document audio presets", threadId: "thread-other" })]);
	expect(results.map((result) => result.status).sort()).toEqual([0, 2]);
	expect(results.find((result) => result.status === 2)?.stderr).toContain("daily idea cap (1");
	expect(questionStates(store).size).toBe(1);
});

test.each([
	["dismissed", 29, true, {}],
	["dismissed", 31, false, {}],
	["declined", 29, true, {}],
	["declined", 31, false, {}],
	["approved", 31, true, {}],
	["dismissed", 2, false, { kind: "product" }],
	["dismissed", 2, false, { days: 1 }],
] as const)(
	"an idea lookup checks a %s record closed %d days ago (blocked: %s)",
	async (outcome, age, blocked, { kind, days }: { kind?: Question["kind"]; days?: number }) => {
		const r = rig(days === undefined ? {} : { declineDays: days });
		const store = r.store();
		const now = Date.now();
		const old = seed(store, "Q-old1", now - 60 * DAY, kind ? { kind } : {});
		const t = new Date(now - age * DAY).toISOString();
		const choice = outcome === "declined" ? 1 : 0;
		const a =
			outcome === "dismissed"
				? plainAnswer("dismissed", old.id, undefined, t)
				: { by: "page" as const, choice, label: old.options[choice]!.label, t, deliveryId: answerDeliveryId(old.id) };
		claimWake(store, pageClaim(old, a));
		const result = await file(r);
		expect(result.status).toBe(blocked ? 2 : 0);
		expect(questionStates(store).size).toBe(blocked ? 1 : 2);
		if (blocked) expect(result.stderr).toContain("Q-old1");
	},
);
