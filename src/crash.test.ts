/**
 * Real crash tests for the one-wake path. Each test kills a real process at a step (CHAMBERLAIN_CRASH_AT makes it
 * SIGKILL itself right after the named step, see src/core/crash.ts), then starts a fresh real process on the same
 * database file and lets its startup pass run:
 * - page path: the dying process is the real src/web/server.ts answering a real HTTP request; the real daemon then relays.
 * - relay path: the real src/daemon.ts sends a row a producer wrote, and dies at each of the relay's steps.
 * Every child runs with HOME, CHAMBERLAIN_CONF and CHAMBERLAIN_STATE in a scratch directory, and wakes go to a local webhook.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CRASH_STEPS } from "./core/crash.ts";
import { withDeliveryId } from "./core/deliver.ts";
import { askQuestion, getQuestion, readClaim, type Question } from "./core/questions.ts";
import { LEGACY_STAMP } from "./core/rights-sent.ts";
import { readRulings } from "./core/rulings.ts";
import { openStore } from "./core/sqlite-store.ts";
import { dbPath, type Store } from "./core/store.ts";

const SRC = new URL(".", import.meta.url).pathname;
const TIMEOUT = 30_000;

let hook: ReturnType<typeof Bun.serve>;
let accepted: { deliveryId: string; message: string }[] = [];
beforeAll(() => {
	hook = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (r) => { accepted.push(await r.json() as { deliveryId: string; message: string }); return new Response(null, { status: 202 }); } });
});
afterAll(() => hook.stop(true));

const dirs: string[] = [];
const procs: { kill: (s?: number) => void }[] = [];
const stores: Store[] = [];
afterEach(() => {
	for (const p of procs.splice(0)) { try { p.kill(9); } catch { /* gone */ } }
	for (const s of stores.splice(0)) { try { s.close(); } catch { /* closed */ } }
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	accepted = [];
});

const item = (id: string): Question => ({
	id, kind: "product", title: "Lead the onboarding with a photo?", context: "Two layouts tested.", options: [{ label: "Photo first" }, { label: "Text first" }], recommended: 0,
	proposedRuling: "Onboarding leads with a photo", thread: "Mobile app", server: "main", threadId: "thread-1", createdAt: "2026-11-09T10:00:00.000Z",
});

const secret = (p: string, body: string) => { writeFileSync(p, body, { mode: 0o600 }); chmodSync(p, 0o600); };
async function freePort() { const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() }); const p = s.port; s.stop(true); return p!; }

/** A scratch HOME with a config dir and a state, the webhook as wake-url, and one asked question in the database. */
async function world(id: string) {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-crash-`);
	dirs.push(root);
	const conf = `${root}/conf`, state = `${root}/state`;
	mkdirSync(conf, { recursive: true, mode: 0o700 }); mkdirSync(state, { recursive: true });
	secret(`${conf}/wake-url`, `http://127.0.0.1:${hook.port}/wake`);
	// The daemon's one server is a port nothing listens on: it starts, recovers, and retries its socket quietly.
	secret(`${conf}/servers.json`, JSON.stringify([{ name: "test", origin: "http://127.0.0.1:9", tokenFile: "read-token", mayBeOffline: true }]));
	secret(`${conf}/read-token`, "not-a-token");
	const port = await freePort();
	secret(`${conf}/web.json`, JSON.stringify({ host: "127.0.0.1", port }));
	// The test's own connection: the same file the children use, read and written alongside them (WAL).
	const store = openStore(dbPath(state));
	stores.push(store);
	askQuestion(store, item(id));
	const env = { ...process.env, HOME: root, CHAMBERLAIN_CONF: conf, CHAMBERLAIN_STATE: state, CHAMBERLAIN_T3_STATE_DB: `${root}/none.sqlite`, CHAMBERLAIN_ALERT_CMD: "/bin/true", CHAMBERLAIN_DRY: "0", CHAMBERLAIN_VERBOSE: "" };
	const events = () => store.events.query({ events: ["startup-recovered", "alarm"] }) as { event: string; src?: string }[];
	const spawn = (args: string[], crashAt?: string, extra: Record<string, string> = {}) => {
		const p = Bun.spawn(["bun", ...args], { env: { ...env, ...extra, ...(crashAt ? { CHAMBERLAIN_CRASH_AT: crashAt } : {}) }, stdout: "ignore", stderr: "pipe" });
		procs.push(p);
		return p;
	};
	const until = async (what: string, ok: () => boolean, ms = 15_000) => {
		const end = Date.now() + ms;
		while (!ok()) { if (Date.now() > end) throw Error(`timed out waiting for ${what}`); await Bun.sleep(25); }
	};
	return { root, conf, state, port, env, store, events, spawn, until };
}
type World = Awaited<ReturnType<typeof world>>;

/** The process must have died by its own SIGKILL at the named step, not finished. */
async function diedAt(p: ReturnType<World["spawn"]>, step: string) {
	await p.exited;
	const err = await new Response(p.stderr).text();
	expect({ step, signal: p.signalCode, err: err.slice(0, 400) }).toEqual({ step, signal: "SIGKILL", err: "" });
}

/** Exactly `n` POSTs, all of this item's one wake, every one under the same delivery id with the same text, ending with that id. */
function wakes(id: string, deliveryId: string, n = 1) {
	const mine = accepted.filter((a) => a.deliveryId === deliveryId);
	expect(accepted.length).toBe(mine.length);
	expect(mine).toHaveLength(n);
	for (const a of mine) expect(a.message).toContain(id);
	for (const a of mine) expect(a.message.split("\n").at(-1)).toContain(`delivery id: ${deliveryId}`);
	expect(new Set(mine.map((a) => a.message)).size).toBeLessThanOrEqual(1);
}

/** Rows the raw database holds, read through a separate connection to the file (no Store): what a crash left on disk. */
const rows = (w: World, sql: string) => { const db = new Database(dbPath(w.state), { readonly: true }); try { return db.query(sql).all() as Record<string, unknown>[]; } finally { db.close(); } };
const outbox = (w: World) => rows(w, "SELECT delivery_id, status, attempts FROM outbox ORDER BY id");

const daemonArgs = [`${SRC}daemon.ts`];
/** A real daemon (the relay) on the world, run until its startup pass is done and `until` holds, then stopped. */
async function daemon(w: World, until: () => boolean = () => true, extra: Record<string, string> = {}) {
	const before = w.events().filter((e) => e.event === "startup-recovered").length;
	const p = w.spawn(daemonArgs, undefined, extra);
	await w.until("the relay's first pass", () => w.events().filter((e) => e.event === "startup-recovered").length > before);
	await w.until("the daemon's work", until);
	await Bun.sleep(200);
	p.kill(); await p.exited;
}

describe("the crash steps are the ones the code names", () => {
	test("every step in CRASH_STEPS is reached by a crashPoint call in the source, and every call names a listed step", () => {
		const sources = ["web/app.ts", "core/deliver.ts", "core/relay.ts"].map((f) => readFileSync(`${SRC}${f}`, "utf8")).join("\n");
		const named = [...sources.matchAll(/crashPoint\("([^"]+)"\)/g)].map((m) => m[1]!);
		expect(new Set(named)).toEqual(new Set(CRASH_STEPS));
	});
});

// ---- the page path ------------------------------------------------------------------------------

describe("page path: the real queue server dies answering a real request, and the daemon's relay sends the one wake", () => {
	const ID = "Q-page1", DELIVERY = "answer:item:Q-page1";
	const server = [`${SRC}web/server.ts`];
	async function crash(step: string, body: Record<string, unknown> = { choice: 0, note: "go with the photo" }) {
		const w = await world(ID);
		const p = w.spawn(server, step);
		await w.until("the page to start", () => w.events().some((e) => e.event === "startup-recovered"));
		const host = `127.0.0.1:${w.port}`;
		const r = await fetch(`http://${host}/api/items/${ID}/answer`, { method: "POST", headers: { host, "content-type": "application/json", "x-decision-queue": "1" }, body: JSON.stringify(body) }).then((x) => x.status, () => "connection lost");
		await diedAt(p, step);
		return { w, r };
	}
	/** A fresh page answers again; it writes the wake and sends nothing itself. */
	const answerAgain = async (w: World, choice = 0) => {
		const before = w.events().filter((e) => e.event === "startup-recovered").length;
		const p = w.spawn(server);
		await w.until("the page to start", () => w.events().filter((e) => e.event === "startup-recovered").length > before);
		const host = `127.0.0.1:${w.port}`;
		const status = await fetch(`http://${host}/api/items/${ID}/answer`, { method: "POST", headers: { host, "content-type": "application/json", "x-decision-queue": "1" }, body: JSON.stringify({ choice }) }).then((x) => x.status);
		p.kill(); await p.exited;
		expect(accepted).toHaveLength(0);
		return status;
	};

	test("before the commit: nothing of the answer exists, nothing is sent, and answering again works once", async () => {
		const { w, r } = await crash("before-commit");
		expect(r).toBe("connection lost");
		expect(readClaim(w.store, ID)).toBeUndefined();
		expect(getQuestion(w.store, ID)!.status).toBe("open");
		expect(rows(w, "SELECT 1 FROM claims")).toEqual([]);
		expect(outbox(w)).toEqual([]);
		await daemon(w);
		expect(accepted).toHaveLength(0);
		expect(await answerAgain(w)).toBe(200);
		await daemon(w, () => accepted.length > 0);
		wakes(ID, DELIVERY);
	}, TIMEOUT);

	test("before the commit, with a ruling ticked: no ruling exists either, and answering again saves exactly one", async () => {
		const { w } = await crash("before-commit", { choice: 0, saveRuling: true });
		expect(readRulings(w.store)).toEqual([]);
		expect(readClaim(w.store, ID)).toBeUndefined();
		expect(await answerAgain(w, 0)).toBe(200);
		await daemon(w, () => accepted.length > 0);
		wakes(ID, DELIVERY);
	}, TIMEOUT);

	test("after the commit: the claim, the answer and the pending row are one commit, and the relay sends the one wake", async () => {
		const { w, r } = await crash("committed");
		expect(r).toBe("connection lost");
		expect(readClaim(w.store, ID)).toMatchObject({ owner: "page", deliveryId: DELIVERY, answer: { label: "Photo first", note: "go with the photo" } });
		expect(getQuestion(w.store, ID)).toMatchObject({ status: "answered", delivered: false });
		expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "pending", attempts: 0 }]);
		expect(accepted).toHaveLength(0);
		await daemon(w, () => accepted.length > 0);
		wakes(ID, DELIVERY);
		expect(accepted[0]!.message).toContain("note: go with the photo");
		expect(getQuestion(w.store, ID)).toMatchObject({ status: "answered", delivered: true });
		await daemon(w);
		wakes(ID, DELIVERY);
	}, TIMEOUT);

	test("after the commit, with a ruling ticked: the ruling is in the same commit as the claim, under the id its wake names", async () => {
		const { w } = await crash("committed", { choice: 0, saveRuling: true });
		const claim = readClaim(w.store, ID) as { ruling?: { id: string } };
		expect(claim.ruling?.id).toMatch(/^R\d+$/);
		expect(readRulings(w.store).filter((x) => x.item === ID).map((x) => [x.id, x.status])).toEqual([[claim.ruling!.id, "in-force"]]);
		await daemon(w, () => accepted.length > 0);
		wakes(ID, DELIVERY);
		expect(accepted[0]!.message).toContain(`ruling: saved as ${claim.ruling!.id}, in force`);
		expect(readRulings(w.store).filter((x) => x.item === ID)).toHaveLength(1);
	}, TIMEOUT);
});

// ---- the relay path -------------------------------------------------------------------------------

describe("relay path: the real daemon dies at each step of sending a row, and its restart keeps the bound", () => {
	const ID = "Q-dmon1", DELIVERY = "answer:item:Q-dmon1";
	/** A producer wrote this row; the daemon dies at `step` sending it. */
	async function left(step: string) {
		const w = await world(ID);
		w.store.wakes.enqueue({ deliveryId: DELIVERY, message: `[chamberlain] answer: item ${ID}`, queuedAt: Date.now() });
		await diedAt(w.spawn(daemonArgs, step), step);
		return w;
	}

	test("inside the attempt's transaction: the count did not commit and nothing was sent; the restart sends it once", async () => {
		const w = await left("attempt-begun");
		expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "pending", attempts: 0 }]);
		expect(accepted).toHaveLength(0);
		await daemon(w, () => accepted.length > 0);
		wakes(ID, DELIVERY);
		expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "delivered", attempts: 1 }]);
	}, TIMEOUT);

	test("after the attempt committed, before the POST: the attempt is spent; the restart sends it once, as attempt two", async () => {
		const w = await left("attempt-counted");
		expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "pending", attempts: 1 }]);
		expect(accepted).toHaveLength(0);
		await daemon(w, () => accepted.length > 0);
		wakes(ID, DELIVERY);
		expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "delivered", attempts: 2 }]);
	}, TIMEOUT);

	test("after the POST was accepted, before the delivered commit: the documented window, two POSTs under one id and one text", async () => {
		const w = await left("accepted");
		wakes(ID, DELIVERY, 1);
		expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "pending", attempts: 1 }]);
		await daemon(w, () => accepted.length > 1);
		wakes(ID, DELIVERY, 2);
		expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "delivered", attempts: 2 }]);
		await daemon(w);
		wakes(ID, DELIVERY, 2);
	}, TIMEOUT);

	test("killed in that window on every start: exactly three POSTs, then a dead letter that no restart sends", async () => {
		const w = await left("accepted");
		for (const n of [2, 3]) await diedAt(w.spawn(daemonArgs, "accepted"), "accepted").then(() => expect(accepted).toHaveLength(n));
		expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "pending", attempts: 3 }]);
		await daemon(w, () => outbox(w)[0]!.status === "dead_letter");
		wakes(ID, DELIVERY, 3);
		expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "dead_letter", attempts: 3 }]);
	}, TIMEOUT);

	test("killed after the count, before the POST, on every start: three attempts, ZERO POSTs, a dead letter nothing delivered (S3)", async () => {
		const w = await left("attempt-counted");
		for (const n of [2, 3]) { await diedAt(w.spawn(daemonArgs, "attempt-counted"), "attempt-counted"); expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "pending", attempts: n }]); }
		await daemon(w, () => outbox(w)[0]!.status === "dead_letter");
		expect(accepted).toHaveLength(0);
		expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "dead_letter", attempts: 3 }]);
		expect(rows(w, "SELECT dedup_key FROM items WHERE source = 'alarm'").map((r) => String(r.dedup_key)).join(" ")).toContain("wake-dead-letter");
	}, TIMEOUT);

	test("after the delivered commit: the restart sends nothing more and the answer is marked delivered", async () => {
		const w = await left("delivered");
		wakes(ID, DELIVERY, 1);
		expect(outbox(w)).toEqual([{ delivery_id: DELIVERY, status: "delivered", attempts: 1 }]);
		await daemon(w);
		wakes(ID, DELIVERY, 1);
	}, TIMEOUT);

	test("after a digest is composed, before it is sent: the restart sends that row, its id and members as composed", async () => {
		const w = await world(ID);
		for (const id of ["sweep:1", "sweep:2"]) w.store.wakes.hold({ deliveryId: id, message: `[chamberlain] sweep: finding ${id}`, queuedAt: Date.now(), kind: "sweep" });
		await diedAt(w.spawn(daemonArgs, "composed"), "composed");
		expect(rows(w, "SELECT 1 FROM held_wakes")).toEqual([]);
		const [digest] = outbox(w);
		expect(digest).toMatchObject({ status: "pending", attempts: 0 });
		expect(rows(w, "SELECT delivery_id FROM outbox_members ORDER BY delivery_id")).toEqual([{ delivery_id: "sweep:1" }, { delivery_id: "sweep:2" }]);
		expect(accepted).toHaveLength(0);
		await daemon(w, () => accepted.length > 0);
		expect(accepted.map((a) => a.deliveryId)).toEqual([String(digest!.delivery_id)]);
		for (const id of ["sweep:1", "sweep:2"]) expect(accepted[0]!.message).toContain(`deliveryId: ${id}`);
		expect(outbox(w)).toEqual([{ ...digest, status: "delivered", attempts: 1 }]);
	}, TIMEOUT);
});

describe("rights first: the real daemon dies between a Steward row's full-rights wake and the row, and the restart sends each once", () => {
	const ID = "Q-rite1", ROW = "legacy:row:1", LATER = "legacy:row:2";
	const TEXT = "[chamberlain] needs_input: a wake queued before the stamps existed.\nDecision rights: unchanged since your last wake and still in force. They are in decision-rights.md and rulings.jsonl in the config directory (rulings.md before the migration).";
	/** A legacy-stamped Steward row (an upgrade or an import): the relay must send the full rights ahead of it. */
	async function legacyRow() {
		const w = await world(ID);
		secret(`${w.conf}/decision-rights.md`, "The Steward may merge green PRs.");
		w.store.wakes.enqueue({ deliveryId: ROW, message: TEXT, queuedAt: Date.now(), kind: "needs_input", rights: [LEGACY_STAMP] });
		return w;
	}
	/** The one prerequisite the relay queued for the row: keyed by the state (`<row>:rights-first:<key>`) and stamped with it, as a full block. */
	const prerequisite = (w: World) => {
		const all = w.store.wakes.rows("all").filter((r) => r.deliveryId.startsWith(`${ROW}:rights-first:`));
		expect(all).toHaveLength(1);
		expect(all[0]!.rights).toHaveLength(1);
		expect(all[0]!.rights![0]!.full).toBe(true);
		return all[0]!;
	};
	/** Exactly one POST of each, the rights first, the row byte for byte as queued, both delivered once, and the record from the prerequisite's stamp. */
	function oneOfEach(w: World) {
		const first = prerequisite(w);
		expect(accepted.map((a) => a.deliveryId)).toEqual([first.deliveryId, ROW]);
		expect(accepted[0]!.message).toContain("Decision rights (standing rules):");
		expect(accepted[0]!.message).toContain("The Steward may merge green PRs.");
		expect(accepted[1]!.message).toBe(withDeliveryId(TEXT, ROW));
		expect(outbox(w)).toEqual([{ delivery_id: ROW, status: "delivered", attempts: 1 }, { delivery_id: first.deliveryId, status: "delivered", attempts: 1 }]);
		const { full: _full, used: _used, ...stamp } = first.rights![0]!;
		expect(w.store.state.get("rights-sent")).toEqual(stamp);
	}
	/** A later row that depends on the rights goes alone: the durable record, not the dead process's memory, shows the Steward holds them. */
	async function laterGoesAlone(w: World) {
		w.store.wakes.enqueue({ deliveryId: LATER, message: "a later wake", queuedAt: Date.now(), kind: "needs_input", rights: [LEGACY_STAMP] });
		await daemon(w, () => accepted.length >= 3);
		expect(accepted.map((a) => a.deliveryId).slice(2)).toEqual([LATER]);
		expect(w.store.wakes.rows("all").filter((r) => r.deliveryId.includes(":rights-first:"))).toHaveLength(1);
	}

	test("killed right after the rights-first wake was queued: nothing was sent; the restart sends it, then the row, once each, and writes the record", async () => {
		const w = await legacyRow();
		await diedAt(w.spawn(daemonArgs, "rights-first-queued"), "rights-first-queued");
		const first = prerequisite(w);
		expect(outbox(w)).toEqual([{ delivery_id: ROW, status: "pending", attempts: 0 }, { delivery_id: first.deliveryId, status: "pending", attempts: 0 }]);
		expect(w.store.state.get("rights-sent")).toBeUndefined();
		expect(accepted).toHaveLength(0);
		await daemon(w, () => accepted.length >= 2);
		oneOfEach(w);
		await daemon(w);
		oneOfEach(w);
		await laterGoesAlone(w);
	}, TIMEOUT);

	test("killed right after the rights-first wake was delivered, before the row: the record was written with it; the restart sends only the row, once", async () => {
		const w = await legacyRow();
		await diedAt(w.spawn(daemonArgs, "delivered"), "delivered");
		const first = prerequisite(w);
		expect(outbox(w)).toEqual([{ delivery_id: ROW, status: "pending", attempts: 0 }, { delivery_id: first.deliveryId, status: "delivered", attempts: 1 }]);
		expect(accepted.map((a) => a.deliveryId)).toEqual([first.deliveryId]);
		expect(w.store.state.get("rights-sent")).toMatchObject({ hash: first.rights![0]!.hash });
		await daemon(w, () => accepted.length >= 2);
		oneOfEach(w);
		await daemon(w);
		oneOfEach(w);
		await laterGoesAlone(w);
	}, TIMEOUT);
});

// ---- one relay per state directory -----------------------------------------------------------------

describe("two real daemons on one state directory: exactly one relays", () => {
	test("the second exits 5 and says why; every wake goes once, from the first; when the first is gone the next one starts", async () => {
		const w = await world("Q-two01");
		const first = w.spawn(daemonArgs);
		await w.until("the first daemon's relay", () => w.events().some((e) => e.event === "startup-recovered"));
		// Another environment (a different runtime and temporary directory) does not make it another relay: the lock is the state directory's.
		const second = w.spawn(daemonArgs, undefined, { XDG_RUNTIME_DIR: `${w.conf}/other-runtime`, TMPDIR: `${w.conf}/other-tmp` });
		expect(await second.exited).toBe(5);
		expect(await new Response(second.stderr).text()).toContain("another chamberlain daemon is already running on this database");
		w.store.wakes.enqueue({ deliveryId: "answer:item:Q-two01", message: "[chamberlain] answer: item Q-two01", queuedAt: Date.now() });
		await w.until("the wake", () => accepted.length > 0);
		await Bun.sleep(2500);
		wakes("Q-two01", "answer:item:Q-two01");
		first.kill(9); await first.exited;
		await daemon(w);
		wakes("Q-two01", "answer:item:Q-two01");
	}, TIMEOUT);
});

// ---- the sweep path ------------------------------------------------------------------------------

describe("sweep path: the real daemon dies between a finding's notification and its wake, and the alert is not lost", () => {
	const FINDING = "the root disk is 97% full";
	/** A daemon whose once-a-minute heartbeat runs every 100 ms, so the first sweep happens at once. */
	const fast = { CHAMBERLAIN_TICK_MS: "100" };
	async function world_() {
		const w = await world("Q-swp01");
		secret(`${w.conf}/sweep.json`, JSON.stringify({ checks: [{ name: "disk", command: ["/bin/echo", JSON.stringify([{ dedupKey: "root", text: FINDING }])] }] }));
		return w;
	}
	const items = (w: World) => rows(w, "SELECT state, notification_count FROM items WHERE source = 'check:disk'");
	const clock = (w: World) => rows(w, "SELECT value FROM state WHERE key = 'sweep-clock'").map((r) => JSON.parse(String(r.value)) as { seeded: boolean });
	/** A fresh daemon, run until `until` holds (or it dies), then stopped. */
	async function run(w: World, until: () => boolean, crashAt?: string) {
		const p = w.spawn(daemonArgs, crashAt, fast);
		if (crashAt) { await diedAt(p, crashAt); return; }
		await w.until("the wake", until);
		await Bun.sleep(400);
		p.kill(); await p.exited;
	}

	test("killed inside the transaction that records the finding and queues its wake: neither exists, and the restart wakes the Steward once", async () => {
		const w = await world_();
		await run(w, () => true, "notified");
		expect(items(w)).toEqual([]);
		expect(rows(w, "SELECT 1 FROM outbox")).toEqual([]);
		expect(rows(w, "SELECT 1 FROM held_wakes")).toEqual([]);
		expect(clock(w).every((c) => !c.seeded)).toBe(true);
		expect(accepted).toHaveLength(0);
		await run(w, () => accepted.length >= 1);
		expect(accepted).toHaveLength(1);
		expect(accepted[0]!.message).toContain(FINDING);
		expect(items(w)).toEqual([{ state: "triggered", notification_count: 1 }]);
		await run(w, () => true);
		expect(accepted).toHaveLength(1);
	}, TIMEOUT);

	test("killed right after that transaction: the finding and its wake are both there, and the restart sends the one wake", async () => {
		const w = await world_();
		await run(w, () => true, "enqueued");
		expect(items(w)).toEqual([{ state: "triggered", notification_count: 1 }]);
		expect(rows(w, "SELECT delivery_id FROM held_wakes")).toHaveLength(1);
		expect(accepted).toHaveLength(0);
		await run(w, () => accepted.length >= 1);
		expect(accepted).toHaveLength(1);
		expect(accepted[0]!.message).toContain(FINDING);
	}, TIMEOUT);
});

// ---- one wake at a time -------------------------------------------------------------------------

/** T3's state database as the gate reads it: one Steward run, in whatever status the test says. */
function stewardDb(path: string, status: string, steward: string) {
	const db = new Database(path);
	db.run("create table if not exists orchestration_v2_projection_runs (thread_id text, ordinal int, status text, requested_at text, payload_json text)");
	db.run("create table if not exists orchestration_v2_projection_messages (message_id text, payload_json text)");
	db.run("create table if not exists orchestration_v2_projection_runtime_requests (thread_id text, created_at text, resolved_at text)");
	db.run("create table if not exists orchestration_v2_projection_turn_items (thread_id text, type text, updated_at text)");
	db.run("delete from orchestration_v2_projection_runs");
	db.run("insert into orchestration_v2_projection_runs values (?,?,?,?,?)", [steward, 1, status, "2026-11-11T10:00:00Z", JSON.stringify({ startedAt: "2026-11-11T10:00:01Z", userMessageId: "m1" })]);
	db.close();
}

describe("an answer is never held: the real page writes it and the real daemon sends it at once while the Steward is busy", () => {
	const ID = "Q-held1", DELIVERY = "answer:item:Q-held1", STEWARD = "steward-1";
	test("busy: the answer is sent at once and nothing is held; a restart, busy or idle, sends nothing more", async () => {
		const w = await world(ID);
		secret(`${w.conf}/steward-thread`, STEWARD);
		const dbFile = `${w.root}/state.sqlite`;
		const env = { CHAMBERLAIN_T3_STATE_DB: dbFile };
		stewardDb(dbFile, "running", STEWARD);
		const page = w.spawn([`${SRC}web/server.ts`], undefined, env);
		await w.until("the page to start", () => w.events().some((e) => e.event === "startup-recovered"));
		const host = `127.0.0.1:${w.port}`;
		const r = await fetch(`http://${host}/api/items/${ID}/answer`, { method: "POST", headers: { host, "content-type": "application/json", "x-decision-queue": "1" }, body: JSON.stringify({ choice: 0 }) });
		expect(r.status).toBe(200);
		expect(await r.json()).toMatchObject({ recorded: true, wake: "queued" });
		page.kill(); await page.exited;
		expect(accepted).toHaveLength(0);
		await daemon(w, () => accepted.length > 0, env);
		wakes(ID, DELIVERY);
		expect(w.store.wakes.held()).toEqual([]);
		expect(getQuestion(w.store, ID)).toMatchObject({ status: "answered", delivered: true });
		for (const status of ["running", "completed"]) {
			stewardDb(dbFile, status, STEWARD);
			await daemon(w, () => true, env);
			wakes(ID, DELIVERY);
		}
	}, TIMEOUT);
});
