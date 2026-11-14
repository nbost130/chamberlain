import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { heldOpen } from "../core/afk.ts";
import { holdCard, reconcileCardHolds } from "../core/card-hold.ts";
import { reconcileItemHolds } from "../core/hold-reconcile.ts";
import {
	askQuestion,
	claimWake,
	getQuestion,
	pageClaim,
	questionStates,
	recordAnswerDelivered,
	type Question,
} from "../core/questions.ts";
import { addInForce, propose, readRulings } from "../core/rulings.ts";
import { openStore } from "../core/sqlite-store.ts";
import { dbPath } from "../core/store.ts";
import { HEALTH_KEY } from "../core/steward-health.ts";
import { testRelay } from "../testing/relay.ts";
import { fetchWake } from "../testing/wake.ts";
import { createApp, type AppDeps } from "./app.ts";
import { canonicalIp, checkBind, loadConfig, parseConfig } from "./config.ts";
import { resolveEvidence } from "./evidence.ts";
import { openCapability } from "../testing/capability.ts";

const HOST = "127.0.0.1:3790";
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const item = (id: string, over: Partial<Question> = {}): Question => ({
	id,
	kind: "product",
	title: `Question ${id}`,
	context: "ctx",
	options: [{ label: "A · One" }, { label: "B · Two" }],
	recommended: 0,
	proposedRuling: "Lead with a photo",
	thread: "Mobile app",
	server: "main",
	threadId: "thread-1",
	createdAt: "2026-11-09T10:00:00.000Z",
	...over,
});

process.env.CHAMBERLAIN_T3_STATE_DB = "/nonexistent/statev2.sqlite";

/**
 * A state directory with its database, a webhook that counts what it receives, the app as server.ts wires it, and the daemon's relay
 * (unless `relay: false`: no daemon running). `app.idle()` waits for the page and then lets the relay run. Pass `root` to build fresh
 * instances over the disk another setup left: a restart.
 */
function setup(opts: { status?: (n: number) => number; root?: string; relay?: boolean; now?: () => number } = {}) {
	const root = opts.root ?? mkdtempSync(`${tmpdir()}/chamberlain-web-`);
	const state = `${root}/state`;
	const store = openStore(dbPath(state));
	if (!opts.root) {
		dirs.push(root);
		addInForce(
			store,
			"you can handle all merge conflicts",
			"Merge conflicts are the Steward's.",
			"chat",
			"stated in chat",
		);
	}
	const posts: { deliveryId: string; message: string }[] = [];
	let n = 0;
	const { drain } = testRelay(
		store,
		fetchWake(() => "http://webhook.test/wake", (async (_u: string, init: RequestInit) => {
			posts.push(JSON.parse(String(init.body)));
			return new Response(null, { status: opts.status ? opts.status(++n) : 202 });
		}) as unknown as typeof fetch),
	);
	const page = createApp({
		capability: openCapability(),
		store,
		state,
		log: () => {},
		hosts: [HOST],
		staticDir: `${root}/static`,
		...(opts.now ? { now: opts.now } : {}),
	});
	const app = {
		...page,
		idle: async () => {
			await page.idle();
			if (opts.relay !== false) await drain();
		},
	};
	/** server.ts's heartbeat (the app's recovery), then the daemon's relay. */
	const tick = async () => {
		await page.recover();
		await drain();
	};
	const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
		app.fetch(
			new Request(`http://${HOST}${path}`, {
				method: "POST",
				headers: { host: HOST, "content-type": "application/json", "x-decision-queue": "1", ...headers },
				body: JSON.stringify(body),
			}),
		);
	const get = (path: string, headers: Record<string, string> = {}) =>
		app.fetch(new Request(`http://${HOST}${path}`, { headers: { host: HOST, ...headers } }));
	const add = (i: Question) => askQuestion(store, i);
	// Only wakes the webhook accepted count; the T3 relay sees a 503 as not received.
	const delivered = () => posts.filter((_, k) => (opts.status ? opts.status(k + 1) : 202) < 300);
	return { root, store, state, app, post, get, add, posts, delivered, tick };
}

describe("answering an item", () => {
	test("queue includes latest health measurement without changing the queue", async () => {
		const s = setup();
		expect((await (await s.get("/api/queue")).json()).health).toBeNull();
		s.store.state.set(HEALTH_KEY, { verdict: "WATCH", at: "2026-11-10T14:00:00Z", report: "context near limit" });
		const data = await (await s.get("/api/queue", { origin: "null" })).json();
		expect(data.health.verdict).toBe("WATCH");
		expect(data.items).toEqual([]);
	});
	test("produces exactly one answer wake, and a second answer is refused", async () => {
		const s = setup();
		s.add(item("Q-abcd"));
		const r = await s.post("/api/items/Q-abcd/answer", { choice: 1, note: "make the skip link bigger" });
		expect(r.status).toBe(200);
		await s.app.idle();
		const again = await s.post("/api/items/Q-abcd/answer", { choice: 0 });
		expect(again.status).toBe(409);
		await s.app.idle();
		expect(s.posts).toHaveLength(1);
		expect(s.posts[0]!.deliveryId).toBe("answer:item:Q-abcd");
		expect(s.posts[0]!.message.startsWith("[chamberlain] answer: ")).toBe(true);
		expect(s.posts[0]!.message).toContain("item: Q-abcd");
		expect(s.posts[0]!.message).toContain("choice: 2. B · Two");
		expect(s.posts[0]!.message).toContain("note: make the skip link bigger");
		expect(getQuestion(s.store, "Q-abcd")!.delivered).toBe(true);
	});
	test("two answers sent at once still give one wake", async () => {
		const s = setup();
		s.add(item("Q-abcd"));
		const rs = await Promise.all([
			s.post("/api/items/Q-abcd/answer", { choice: 0 }),
			s.post("/api/items/Q-abcd/answer", { choice: 1 }),
		]);
		await s.app.idle();
		expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
		expect(s.posts).toHaveLength(1);
	});
	test("a retried delivery keeps its one delivery ID and lands once", async () => {
		const s = setup({ status: (n) => (n <= 2 ? 503 : 202) });
		s.add(item("Q-abcd"));
		await s.post("/api/items/Q-abcd/answer", { choice: 0 });
		await s.app.idle();
		expect(new Set(s.posts.map((p) => p.deliveryId))).toEqual(new Set(["answer:item:Q-abcd"]));
		expect(s.delivered()).toHaveLength(1);
		// A heartbeat afterwards sends nothing more: the answer is recorded as delivered.
		await s.app.recover();
		expect(s.posts).toHaveLength(3);
	});
	test("a wake that never delivered is attempted three times, then kept as a dead letter that recovery neither re-sends nor re-queues", async () => {
		const s = setup({ status: () => 503 });
		s.add(item("Q-abcd"));
		await s.post("/api/items/Q-abcd/answer", { choice: 0 });
		await s.app.idle();
		expect(s.posts).toHaveLength(3);
		expect(s.store.wakes.rows("dead_letter").map((w) => w.deliveryId)).toEqual(["answer:item:Q-abcd"]);
		await s.tick();
		expect(s.posts).toHaveLength(3);
	});
	test("restart: a wake queued while no daemon ran is sent once by the next one, then never again", async () => {
		const first = setup({ relay: false });
		first.add(item("Q-abcd"));
		await first.post("/api/items/Q-abcd/answer", { choice: 0 });
		await first.app.idle();
		expect(first.delivered()).toHaveLength(0);
		// The process stops. A new one starts over the same files, and now the webhook answers.
		const second = setup({ root: first.root });
		expect(second.store.wakes.rows().map((w) => w.deliveryId)).toEqual(["answer:item:Q-abcd"]);
		await second.tick();
		expect(second.delivered().map((p) => p.deliveryId)).toEqual(["answer:item:Q-abcd"]);
		expect(getQuestion(second.store, "Q-abcd")!.delivered).toBe(true);
		expect(second.store.wakes.rows()).toEqual([]);
		const third = setup({ root: first.root });
		await third.tick();
		await third.tick();
		expect(third.posts).toHaveLength(0);
	});
	test("restart after a crash between the delivery and the answer's delivered mark: nothing is sent twice", async () => {
		const first = setup({ relay: false });
		first.add(item("Q-abcd"));
		await first.post("/api/items/Q-abcd/answer", { choice: 0 });
		await first.app.idle();
		const second = setup({ root: first.root });
		await second.tick();
		expect(second.delivered()).toHaveLength(1);
		expect(getQuestion(second.store, "Q-abcd")!.delivered).toBe(true);
		// The crash: the row committed delivered, but the process died before
		// the question was marked delivered. Put the question back as it was, in the database file itself.
		const raw = new Database(dbPath(first.state));
		raw.run("UPDATE items SET state = 'triggered', resolved_at = NULL WHERE dedup_key = 'Q-abcd'");
		raw.close();
		expect(getQuestion(second.store, "Q-abcd")!.delivered).toBe(false);
		const third = setup({ root: first.root });
		expect(third.store.wakes.rows()).toEqual([]);
		await third.tick();
		expect(third.posts).toHaveLength(0);
		expect(getQuestion(third.store, "Q-abcd")!.delivered).toBe(true);
	});
	test("a claim with no outbox row (made before the row was part of the answer): recovery writes it, and it is sent once", async () => {
		const first = setup();
		first.add(item("Q-abcd"));
		// A claim alone, as an older page left it: the claim carries the answer and its wake, and no outbox row exists.
		const a = {
			choice: 0,
			label: "A · One",
			by: "page" as const,
			t: new Date().toISOString(),
			deliveryId: "answer:item:Q-abcd",
		};
		claimWake(first.store, pageClaim(item("Q-abcd"), a));
		expect(getQuestion(first.store, "Q-abcd")).toMatchObject({ status: "answered", delivered: false });
		const second = setup({ root: first.root });
		await second.tick();
		const third = setup({ root: first.root });
		await third.tick();
		expect([...second.posts, ...third.posts].map((p) => p.deliveryId)).toEqual(["answer:item:Q-abcd"]);
		expect(second.posts[0]!.message).toContain("item: Q-abcd");
		// The page's record is derived from the claim: the item reads answered and delivered.
		expect(getQuestion(first.store, "Q-abcd")).toMatchObject({ status: "answered", delivered: true });
	});
	test('(4) a card pointer\'s "leave it" answer is refused: the hold stays open while the card waits, and closes only when the card does', async () => {
		const s = setup();
		const { item: id } = holdCard(s.store, {
			thread: "Release",
			server: "main",
			threadId: "th-1",
			requestId: "a1",
			type: "approval_request",
			label: "bun run deploy",
		});
		const q = getQuestion(s.store, id)!;
		// No option says the card was handled.
		expect(q.options.map((o) => o.label).join(" | ")).not.toMatch(/answered|done|handled|approved/i);
		const leave = q.options.findIndex((o) => /leave/i.test(o.label));
		const r = await s.post(`/api/items/${id}/answer`, { choice: leave });
		expect(r.status).toBe(409);
		expect((await r.json()).error).toContain("act on the card itself");
		await s.app.idle();
		expect(s.posts).toHaveLength(0);
		expect(s.store.claims.list("queue")).toEqual([]);
		expect(reconcileItemHolds(s.store)).toEqual({ closed: 0 });
		expect(
			await reconcileCardHolds(s.store, async () => ({
				ok: true as const,
				waiting: new Set(["a1"]),
				resolved: new Set<string>(),
			})),
		).toEqual({ closed: [], verified: [expect.objectContaining({ requestId: "a1" })], unverified: [], failed: [] });
		expect(heldOpen(s.store)).toHaveLength(1);
		expect(getQuestion(s.store, id)!.status).toBe("open");
		// The card resolves: now, and only now, the question and the hold close.
		expect(
			(
				await reconcileCardHolds(s.store, async () => ({
					ok: true as const,
					waiting: new Set<string>(),
					resolved: new Set(["a1"]),
				}))
			).closed,
		).toHaveLength(1);
		expect(heldOpen(s.store)).toEqual([]);
		expect(getQuestion(s.store, id)!.status).toBe("answered-on-card");
	});
	test("(4) a pointer answered before this fix (a claim already on it) does not close its hold while the card waits", async () => {
		const s = setup();
		const { item: id } = holdCard(s.store, {
			thread: "Release",
			server: "main",
			threadId: "th-1",
			requestId: "a1",
			type: "approval_request",
			label: "deploy",
		});
		const q = getQuestion(s.store, id)!;
		claimWake(
			s.store,
			pageClaim(q, {
				choice: 1,
				label: "Leave it for now",
				by: "page",
				t: new Date().toISOString(),
				deliveryId: `answer:item:${id}`,
			}),
		);
		expect(getQuestion(s.store, id)!.status).toBe("answered");
		expect(reconcileItemHolds(s.store)).toEqual({ closed: 0 });
		expect(heldOpen(s.store)).toHaveLength(1);
		expect(
			(
				await reconcileCardHolds(s.store, async () => ({
					ok: true as const,
					waiting: new Set(["a1"]),
					resolved: new Set<string>(),
				}))
			).closed,
		).toEqual([]);
		expect(heldOpen(s.store)).toHaveLength(1);
		expect(
			(
				await reconcileCardHolds(s.store, async () => ({
					ok: true as const,
					waiting: new Set<string>(),
					resolved: new Set(["a1"]),
				}))
			).closed,
		).toHaveLength(1);
		expect(heldOpen(s.store)).toEqual([]);
	});
	test("a secret item is never answered on the page", async () => {
		const s = setup();
		s.add(item("Q-secr", { kind: "only-you", secret: true, options: [] }));
		const r = await s.post("/api/items/Q-secr/answer", { choice: 0, note: "hunter2" });
		expect(r.status).toBe(400);
		await s.app.idle();
		expect(s.posts).toHaveLength(0);
		expect(JSON.stringify([...questionStates(s.store).values()])).not.toContain("hunter2");
		expect(s.store.claims.list("queue")).toEqual([]);
	});
});

describe("schema versions at server start", () => {
	const start = (setupFiles: (conf: string, state: string) => void) => {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-srv-`);
		dirs.push(root);
		const conf = `${root}/conf`,
			state = `${root}/state`;
		mkdirSync(conf, { mode: 0o700 });
		mkdirSync(state);
		const port = 40000 + Math.floor(Math.random() * 20000);
		writeFileSync(`${conf}/web.json`, JSON.stringify({ host: "127.0.0.1", port }), { mode: 0o600 });
		setupFiles(conf, state);
		const p = Bun.spawn([process.execPath, new URL("./server.ts", import.meta.url).pathname, "--test"], {
			env: {
				...process.env,
				CHAMBERLAIN_CONF: conf,
				CHAMBERLAIN_STATE: state,
				CHAMBERLAIN_T3_STATE_DB: "/nonexistent/statev2.sqlite",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		return { p, conf, state };
	};
	test("a new install creates its database and starts", async () => {
		const { p, state } = start(() => {});
		try {
			const reader = p.stdout.getReader();
			let out = "";
			const deadline = Date.now() + 10_000;
			while (!out.includes("decision queue on") && Date.now() < deadline) {
				const { value, done } = await reader.read();
				if (done) break;
				out += new TextDecoder().decode(value);
			}
			expect(out).toContain("decision queue on");
			expect(existsSync(dbPath(state))).toBe(true);
		} finally {
			p.kill();
			await p.exited;
		}
	});
	test("a config file from a newer Chamberlain stops the server with exit code 3 and a clear reason", async () => {
		const { p } = start((conf) =>
			writeFileSync(`${conf}/settings.json`, JSON.stringify({ schemaVersion: 9 }), { mode: 0o600 }),
		);
		const err = await new Response(p.stderr).text();
		expect(await p.exited).toBe(3);
		expect(err).toContain("settings.json has schemaVersion 9");
		expect(err).toContain("newer Chamberlain");
	});
	test("a database from a newer Chamberlain stops the server with exit code 3 and a clear reason", async () => {
		const { p } = start((_c, state) => {
			const store = openStore(dbPath(state));
			store.close();
			const raw = new Database(dbPath(state));
			raw.run("INSERT INTO migrations (version, name, applied_at) VALUES (99, 'from the future', 'now')");
			raw.close();
		});
		const err = await new Response(p.stderr).text();
		expect(await p.exited).toBe(3);
		expect(err).toContain("migration 99");
		expect(err).toContain("newer Chamberlain");
	});
});

describe("rulings from the page", () => {
	test("no ruling is saved unless the box is checked", async () => {
		const s = setup();
		s.add(item("Q-abcd"));
		const before = readRulings(s.store).length;
		await s.post("/api/items/Q-abcd/answer", { choice: 0 });
		await s.app.idle();
		expect(readRulings(s.store)).toHaveLength(before);
		expect(s.posts[0]!.message).toContain("ruling: none saved");
	});
	test("a checked box creates the ruling in force with confirmed:true, and the wake says so", async () => {
		const s = setup();
		s.add(item("Q-abcd"));
		const r = await s.post("/api/items/Q-abcd/answer", {
			choice: 0,
			saveRuling: true,
			rulingWording: "Onboarding screens lead with a photo",
		});
		const { ruling } = (await r.json()) as { ruling: string };
		await s.app.idle();
		const saved = readRulings(s.store).find((x) => x.id === ruling)!;
		expect(saved.status).toBe("in-force");
		expect(saved.confirmed).toBe(true);
		expect(saved.decides).toBe("Onboarding screens lead with a photo");
		expect(saved.item).toBe("Q-abcd");
		expect(s.posts[0]!.message).toContain(`ruling: saved as ${ruling}, in force and confirmed by the operator`);
	});
	test("Accept all never saves a ruling, even with saveRuling sent", async () => {
		const s = setup();
		s.add(item("Q-abcd"));
		const before = readRulings(s.store).length;
		await s.post("/api/accept-all", { ids: ["Q-abcd"], saveRuling: true });
		await s.app.idle();
		expect(readRulings(s.store)).toHaveLength(before);
	});
	test("confirm, edit, only this once and retire on the rulings page", async () => {
		const s = setup();
		const { propose } = await import("../core/rulings.ts");
		const p = propose(s.store, "Approve (Recommended)", "gates");
		expect((await s.post(`/api/rulings/${p.id}/edit`, { decides: "gates like this" })).status).toBe(200);
		expect(readRulings(s.store).find((x) => x.id === p.id)!.status).toBe("proposed");
		expect((await s.post(`/api/rulings/${p.id}/confirm`, {})).status).toBe(200);
		expect(readRulings(s.store).find((x) => x.id === p.id)).toMatchObject({
			status: "in-force",
			confirmed: true,
			decides: "gates like this",
		});
		expect((await s.post("/api/rulings/R1/once", {})).status).toBe(200);
		expect(readRulings(s.store).find((x) => x.id === "R1")).toMatchObject({
			status: "retired",
			retiredHow: "only this once",
		});
		const view = (await (await s.get("/api/rulings")).json()) as { rulings: { id: string }[] };
		expect(view.rulings.map((x) => x.id)).toContain("R1");
	});
	test("a ruling saved from a question with proposedExpires carries the expiry, and the page marks it expired when the clock passes it", async () => {
		let t = Date.parse("2026-11-13T12:00:00Z");
		const s = setup({ now: () => t });
		s.add(item("Q-abcd", { proposedExpires: "2026-11-20" }));
		const { ruling } = (await (await s.post("/api/items/Q-abcd/answer", { choice: 0, saveRuling: true })).json()) as {
			ruling: string;
		};
		await s.app.idle();
		expect(readRulings(s.store).find((x) => x.id === ruling)).toMatchObject({
			status: "in-force",
			expires: "2026-11-20",
		});
		const inForceCount = async () => ((await (await s.get("/api/queue")).json()) as { inForce: number }).inForce;
		const view = async () =>
			((await (await s.get("/api/rulings")).json()) as { rulings: { id: string; expired: boolean }[] }).rulings;
		expect(await inForceCount()).toBe(2);
		expect((await view()).find((r) => r.id === ruling)!.expired).toBe(false);
		t = Date.parse("2026-11-21T00:00:00Z");
		expect(await inForceCount()).toBe(1);
		expect((await view()).find((r) => r.id === ruling)).toMatchObject({ expired: true, status: "in-force" });
		expect((await view()).find((r) => r.id === "R1")!.expired).toBe(false);
		// An expired ruling cannot be confirmed from the page.
		const c = await s.post(`/api/rulings/${ruling}/confirm`, {});
		expect(c.status).toBe(400);
		expect(((await c.json()) as { error: string }).error).toContain("expired on 2026-11-20");
	});
	test("saving a ruling whose proposed expiry has passed is refused before anything is claimed", async () => {
		let t = Date.parse("2026-11-13T12:00:00Z");
		const s = setup({ now: () => t });
		s.add(item("Q-abcd", { proposedExpires: "2026-11-14" }));
		t = Date.parse("2026-11-15T00:00:00Z");
		const before = readRulings(s.store).length;
		const r = await s.post("/api/items/Q-abcd/answer", { choice: 0, saveRuling: true });
		expect(r.status).toBe(400);
		expect(((await r.json()) as { error: string }).error).toContain("expired on 2026-11-14");
		expect(readRulings(s.store)).toHaveLength(before);
		expect(getQuestion(s.store, "Q-abcd")!.status).toBe("open");
		// Answering without saving a ruling still works.
		expect((await s.post("/api/items/Q-abcd/answer", { choice: 0 })).status).toBe(200);
	});
	test("saving a ruling whose stored proposed expiry does not exist is refused with that reason, before anything is claimed", async () => {
		const s = setup({ now: () => Date.parse("2026-11-13T12:00:00Z") });
		s.add(item("Q-abcd", { proposedExpires: "2027-02-30T09:00:00Z" }));
		const before = readRulings(s.store).length;
		const r = await s.post("/api/items/Q-abcd/answer", { choice: 0, saveRuling: true });
		expect(r.status).toBe(400);
		expect(((await r.json()) as { error: string }).error).toContain(
			'"2027-02-30T09:00:00Z" is not a real date and time',
		);
		expect(readRulings(s.store)).toHaveLength(before);
		expect(getQuestion(s.store, "Q-abcd")!.status).toBe("open");
	});
	test("two questions saved with the same wording and choice give one ruling, and both answers cite it", async () => {
		const s = setup();
		s.add(item("Q-abcd"));
		s.add(item("Q-efgh"));
		const a = (await (await s.post("/api/items/Q-abcd/answer", { choice: 0, saveRuling: true })).json()) as {
			ruling: string;
		};
		const b = (await (await s.post("/api/items/Q-efgh/answer", { choice: 0, saveRuling: true })).json()) as {
			ruling: string;
		};
		await s.app.idle();
		expect(b.ruling).toBe(a.ruling);
		expect(readRulings(s.store).filter((x) => x.decides === "Lead with a photo")).toHaveLength(1);
		expect(s.posts.map((p) => p.message).filter((m) => m.includes(`saved as ${a.ruling}`))).toHaveLength(2);
	});
	test("saving a ruling the Steward already proposed in the same words puts that proposal in force, not a second ruling", async () => {
		const s = setup();
		const p = propose(s.store, "A · One", "Lead with a photo");
		s.add(item("Q-abcd"));
		const r = (await (await s.post("/api/items/Q-abcd/answer", { choice: 0, saveRuling: true })).json()) as {
			ruling: string;
		};
		await s.app.idle();
		expect(r.ruling).toBe(p.id);
		expect(readRulings(s.store).find((x) => x.id === p.id)).toMatchObject({ status: "in-force", confirmed: true });
		expect(readRulings(s.store).filter((x) => x.decides === "Lead with a photo")).toHaveLength(1);
	});
	test("a refused second answer saves no ruling, and does not promote a held proposal", async () => {
		const s = setup();
		const p = propose(s.store, "A · One", "Lead with a photo");
		s.add(item("Q-abcd"));
		expect((await s.post("/api/items/Q-abcd/answer", { choice: 1 })).status).toBe(200);
		const r = await s.post("/api/items/Q-abcd/answer", { choice: 0, saveRuling: true });
		expect(r.status).toBe(409);
		expect(readRulings(s.store).find((x) => x.id === p.id)!.status).toBe("proposed");
	});
	test("the rulings page counts citations by ID from the decision log", async () => {
		const s = setup();
		for (const d of [
			{ t: "2026-11-09T01:00:00Z", thread: "a", decision: "took it", ruling: "R1", rulingIds: ["R1"], ref: null },
			{ t: "2026-11-09T02:00:00Z", thread: "b", decision: "again", ruling: "R1: same", rulingIds: ["R1"], ref: null },
			{ t: "2026-11-09T03:00:00Z", thread: "c", decision: "free", ruling: "merge conflicts", ref: null },
		])
			s.store.decisions.append(d);
		const view = (await (await s.get("/api/rulings")).json()) as {
			rulings: { id: string; cited: number; recent: { decision: string }[] }[];
		};
		expect(view.rulings.find((r) => r.id === "R1")).toMatchObject({ cited: 2 });
		expect(view.rulings.find((r) => r.id === "R1")!.recent[0]!.decision).toBe("again");
	});
});

describe("Accept all recommendations", () => {
	test("never includes an only-you item, a secret or one with no recommendation", async () => {
		const s = setup();
		s.add(item("Q-only", { kind: "only-you" }));
		s.add(item("Q-secr", { secret: true }));
		s.add(item("Q-norc", { recommended: undefined }));
		s.add(item("Q-good"));
		const r = (await (await s.post("/api/accept-all", { ids: ["Q-only", "Q-secr", "Q-norc", "Q-good"] })).json()) as {
			answered: string[];
			skipped: { id: string }[];
		};
		await s.app.idle();
		expect(r.answered).toEqual(["Q-good"]);
		expect(r.skipped.map((x) => x.id)).toEqual(["Q-only", "Q-secr", "Q-norc"]);
		const st = questionStates(s.store);
		expect(st.get("Q-only")!.status).toBe("open");
		expect(s.posts.map((p) => p.deliveryId)).toEqual(["answer:item:Q-good"]);
		expect(s.posts[0]!.message).toContain("(accepted with every recommendation)");
	});
});

describe("bind address", () => {
	// Every spelling of the unspecified address, IPv4 and IPv6, including IPv4-mapped forms.
	const UNSPECIFIED = [
		"0.0.0.0",
		"::",
		"[::]",
		"::0",
		"0::",
		"0::0",
		"0:0:0:0:0:0:0:0",
		"0000:0000:0000:0000:0000:0000:0000:0000",
		"0:0:0::0:0",
		"::0:0:0",
		"::0.0.0.0",
		"::ffff:0.0.0.0",
		"::ffff:0:0",
		"::ffff:0000:0000",
		"0:0:0:0:0:ffff:0:0",
		"0000:0000:0000:0000:0000:ffff:0000:0000",
		"0:0:0:0:0:FFFF:0.0.0.0",
		"::FFFF:0:0",
		"[::ffff:0:0]",
		"[0:0:0:0:0:ffff:0:0]",
	];
	// Forms some resolvers read as an address, which an IP literal check must not let through as something else.
	const AMBIGUOUS = [
		"00.0.0.0",
		"0",
		"0x0",
		"0x7f000001",
		"127.1",
		"127.000.000.001",
		"0177.0.0.1",
		"2130706433",
		"127.0.0.1:3790",
		"fe80::1%eth0",
		"::1%lo",
		"1::2::3",
		"12345::1",
		"::ffff:1.2.3",
		"::ffff:256.0.0.1",
	];
	const OUTSIDE = [
		"198.51.100.7",
		"192.168.1.5",
		"10.0.0.1",
		"127.0.0.2",
		"100.63.255.255",
		"100.128.0.1",
		"fe80::1",
		"fd7a:115c:a1e1::1",
		"fd7a:115c:a1df::1",
		"2001:db8::1",
		"::ffff:198.51.100.7",
		"::ffff:192.168.1.5",
		"0:0:0:0:0:ffff:c0a8:105",
		"::2",
	];
	test("refuses every spelling of the unspecified address, and a missing one", () => {
		for (const bad of [undefined, "", "  ", ...UNSPECIFIED]) expect(() => checkBind(bad)).toThrow();
		expect(() => parseConfig({})).toThrow(/no bind address/);
		expect(() => parseConfig({ host: "0.0.0.0", port: 3790 })).toThrow(/not loopback or a Tailscale address/);
		for (const h of UNSPECIFIED) expect(() => parseConfig({ host: h })).toThrow(/not loopback or a Tailscale address/);
	});
	test("refuses ambiguous numeric forms, ports and zone IDs as not an IP literal", () => {
		for (const bad of AMBIGUOUS) expect(() => checkBind(bad)).toThrow(/not an IP/);
	});
	test("refuses every address outside loopback and Tailscale, however it is spelled", () => {
		for (const bad of OUTSIDE) expect(() => checkBind(bad)).toThrow(/not loopback or a Tailscale address/);
	});
	test("refuses a host name, which could resolve to anything", () => {
		for (const bad of ["localhost", "host.tail1234.ts.net", "0", "ip6-localhost"])
			expect(() => checkBind(bad)).toThrow(/not an IP/);
	});
	test("accepts loopback and Tailscale in any spelling, and binds to the canonical form", () => {
		expect(checkBind("100.64.0.7")).toBe("100.64.0.7");
		expect(checkBind("100.64.0.0")).toBe("100.64.0.0");
		expect(checkBind("100.127.255.255")).toBe("100.127.255.255");
		expect(checkBind("::ffff:100.64.0.7")).toBe("100.64.0.7");
		expect(checkBind("::ffff:6440:7")).toBe("100.64.0.7");
		expect(checkBind("127.0.0.1")).toBe("127.0.0.1");
		expect(checkBind("::ffff:127.0.0.1")).toBe("127.0.0.1");
		expect(checkBind("0:0:0:0:0:ffff:7f00:1")).toBe("127.0.0.1");
		expect(checkBind("::1")).toBe("::1");
		expect(checkBind("[::1]")).toBe("::1");
		expect(checkBind("0000:0000:0000:0000:0000:0000:0000:0001")).toBe("::1");
		expect(checkBind("FD7A:115C:A1E0::1234")).toBe("fd7a:115c:a1e0::1234");
		expect(checkBind("fd7a:115c:a1e0:ab12:4843:cd96:6258:b240")).toBe("fd7a:115c:a1e0:ab12:4843:cd96:6258:b240");
		expect(checkBind("fd7a:115c:a1e0:0000:0000:0000:0000:0001")).toBe("fd7a:115c:a1e0::1");
		expect(parseConfig({ host: "100.64.0.7" }).port).toBe(3790);
	});
	test("canonical forms agree with the platform's own parser", async () => {
		const { isIP } = await import("node:net");
		for (const h of [...UNSPECIFIED, ...OUTSIDE].map((x) => x.replace(/^\[|\]$/g, ""))) {
			const c = canonicalIp(h)!;
			expect(c).toBeDefined();
			expect(isIP(c.text)).toBe(c.family);
		}
		for (const h of UNSPECIFIED) expect(canonicalIp(h)!.bytes.every((b) => b === 0)).toBe(true);
	});
	test("refuses a web.json that group or others can read, as afk.ts refuses afk.json", () => {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-cfg-`);
		dirs.push(root);
		writeFileSync(`${root}/web.json`, JSON.stringify({ host: "127.0.0.1", port: 3790 }));
		for (const mode of [0o644, 0o640, 0o604, 0o660]) {
			chmodSync(`${root}/web.json`, mode);
			expect(() => loadConfig(root)).toThrow(/0600/);
		}
		chmodSync(`${root}/web.json`, 0o600);
		expect(loadConfig(root).host).toBe("127.0.0.1");
	});
	test("the server process exits before listening when the address is a wildcard, missing, or web.json is 0644", () => {
		for (const [cfg, mode] of [
			[{ host: "0.0.0.0", port: 3791 }, 0o600],
			[{ host: "::ffff:0000:0000", port: 3791 }, 0o600],
			[{ host: "0:0:0:0:0:ffff:0:0", port: 3791 }, 0o600],
			[{ host: "127.0.0.1", port: 3791 }, 0o644],
			[{ port: 3791 }, 0o600],
			[null, 0],
		] as const) {
			const root = mkdtempSync(`${tmpdir()}/chamberlain-bind-`);
			dirs.push(root);
			if (cfg) {
				writeFileSync(`${root}/web.json`, JSON.stringify(cfg));
				chmodSync(`${root}/web.json`, mode);
			}
			const r = Bun.spawnSync([process.execPath, new URL("./server.ts", import.meta.url).pathname], {
				env: { ...process.env, CHAMBERLAIN_CONF: root, CHAMBERLAIN_STATE: root },
				stdout: "pipe",
				stderr: "pipe",
				timeout: 10_000,
			});
			expect(r.exitCode).toBe(2);
			expect(r.stdout.toString()).not.toContain("decision queue on");
		}
	});
});

describe("evidence", () => {
	function tree() {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-ev-`);
		dirs.push(root);
		const ev = `${root}/evidence`;
		mkdirSync(`${ev}/Q-abcd`, { recursive: true });
		mkdirSync(`${ev}/Q-other`, { recursive: true });
		writeFileSync(`${ev}/Q-abcd/shot.png`, "png");
		writeFileSync(`${ev}/Q-other/x.png`, "png");
		writeFileSync(`${root}/secret.png`, "secret");
		symlinkSync(`${root}/secret.png`, `${ev}/Q-abcd/link.png`);
		symlinkSync(root, `${ev}/Q-link`);
		// resolveEvidence takes the state dir; the tree's root plays it.
		return { root, ev: root };
	}
	test("serves a listed file from the item's own folder", () => {
		const { ev } = tree();
		expect(resolveEvidence(ev, "Q-abcd", "shot.png", ["shot.png"])?.type).toBe("image/png");
	});
	test("refuses everything when the evidence folder itself is a symlink out of the state", async () => {
		const outside = mkdtempSync(`${tmpdir()}/chamberlain-outside-`);
		dirs.push(outside);
		mkdirSync(`${outside}/Q-abcd`);
		writeFileSync(`${outside}/Q-abcd/shot.png`, "secret");
		const s = setup();
		symlinkSync(outside, `${s.state}/evidence`);
		s.add(item("Q-abcd", { evidence: [{ type: "image", path: "shot.png" }] }));
		expect(resolveEvidence(s.state, "Q-abcd", "shot.png", ["shot.png"])).toBeUndefined();
		expect((await s.get("/evidence/Q-abcd/shot.png")).status).toBe(404);
		// Even a symlink that stays inside the state is refused: the folder must be the state's own evidence folder.
		const s2 = setup();
		mkdirSync(`${s2.state}/elsewhere/Q-abcd`, { recursive: true });
		writeFileSync(`${s2.state}/elsewhere/Q-abcd/shot.png`, "png");
		symlinkSync(`${s2.state}/elsewhere`, `${s2.state}/evidence`);
		expect(resolveEvidence(s2.state, "Q-abcd", "shot.png", ["shot.png"])).toBeUndefined();
	});
	test("a state reached through a symlink still serves its own evidence", () => {
		const { root } = tree();
		const link = `${root}-link`;
		symlinkSync(root, link);
		dirs.push(link);
		expect(resolveEvidence(link, "Q-abcd", "shot.png", ["shot.png"])?.type).toBe("image/png");
	});
	test("rejects ../, absolute paths, encoded slashes, unlisted names and symlinks out of the folder", () => {
		const { ev } = tree();
		expect(resolveEvidence(ev, "Q-abcd", "../Q-other/x.png", ["../Q-other/x.png"])).toBeUndefined();
		expect(resolveEvidence(ev, "Q-abcd", "/etc/passwd", ["/etc/passwd"])).toBeUndefined();
		expect(resolveEvidence(ev, "..", "secret.png", ["secret.png"])).toBeUndefined();
		expect(resolveEvidence(ev, "Q-abcd", "x.png", ["shot.png"])).toBeUndefined();
		expect(resolveEvidence(ev, "Q-abcd", "link.png", ["link.png"])).toBeUndefined();
		expect(resolveEvidence(ev, "Q-link", "secret.png", ["secret.png"])).toBeUndefined();
		expect(resolveEvidence(ev, "Q-abcd", "shot.exe", ["shot.exe"])).toBeUndefined();
	});
	test("the route refuses traversal however it is spelled", async () => {
		const s = setup();
		mkdirSync(`${s.state}/evidence/Q-abcd`, { recursive: true });
		writeFileSync(`${s.state}/evidence/Q-abcd/shot.png`, "png");
		writeFileSync(`${s.state}/top.png`, "nope");
		s.add(item("Q-abcd", { evidence: [{ type: "image", path: "shot.png" }] }));
		expect((await s.get("/evidence/Q-abcd/shot.png")).status).toBe(200);
		for (const p of [
			"/evidence/Q-abcd/..%2F..%2Ftop.png",
			"/evidence/Q-abcd/%2e%2e/top.png",
			"/evidence/..%2Ftop.png/x",
			"/evidence/Q-abcd/%2Fetc%2Fpasswd",
			"/evidence/Q-abcd/shot.png/..",
			"/evidence/Q-abcd",
		]) {
			expect((await s.get(p)).status).toBe(404);
		}
	});
});

describe("request guards", () => {
	test("refuses an unknown Host, which is how DNS rebinding arrives", async () => {
		const s = setup();
		expect(
			(await s.app.fetch(new Request("http://evil.example/api/queue", { headers: { host: "evil.example" } }))).status,
		).toBe(421);
	});
	test("refuses a POST without the page's header or from another origin", async () => {
		const s = setup();
		s.add(item("Q-abcd"));
		const form = await s.app.fetch(
			new Request(`http://${HOST}/api/items/Q-abcd/answer`, {
				method: "POST",
				headers: { host: HOST, "content-type": "application/x-www-form-urlencoded" },
				body: "choice=0",
			}),
		);
		expect(form.status).toBe(403);
		expect((await s.post("/api/items/Q-abcd/answer", { choice: 0 }, { origin: "https://evil.example" })).status).toBe(
			403,
		);
		expect((await s.post("/api/items/Q-abcd/answer", { choice: 0 }, { "x-decision-queue": "" })).status).toBe(403);
		await s.app.idle();
		expect(s.posts).toHaveLength(0);
	});
	test("the queue lists open items ranked, with only-you first", async () => {
		const s = setup();
		s.add(item("Q-prod"));
		s.add(item("Q-only", { kind: "only-you", createdAt: "2026-11-09T12:00:00.000Z" }));
		const q = (await (await s.get("/api/queue")).json()) as { items: { id: string; batchable: boolean }[] };
		expect(q.items.map((i) => i.id)).toEqual(["Q-only", "Q-prod"]);
		expect(q.items.map((i) => i.batchable)).toEqual([false, true]);
	});
});
