/**
 * The importer on fixture directories built here, never on real data: the old file layout in both shapes (the versioned files
 * this project wrote, and the unversioned ones the earlier system wrote), its idempotence, and that it reads and never writes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { withDeliveryId } from "./deliver.ts";
import { testRelay } from "../testing/relay.ts";
import { fetchWake } from "../testing/wake.ts";
import { memStore } from "../testing/store.ts";
import { heldOpen } from "./afk.ts";
import { formatReport, importLegacy } from "./legacy-import.ts";
import { answerDeliveryId, getQuestion, pageClaim, questionStates, QUEUE, readClaim, readRelay, recordAnswerDelivered, type Answer, type Question } from "./questions.ts";
import { inForceNow, readRulings, type Ruling } from "./rulings.ts";
import { SchemaTooNewError } from "./schema.ts";
import { openStore } from "./sqlite-store.ts";
import { dbPath, type Store } from "./store.ts";
import { createApp } from "../web/app.ts";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = mkdtempSync(`${tmpdir()}/chamberlain-import-`); dirs.push(d); return d; };

const NOW = Date.parse("2026-11-12T12:00:00Z");
const T = (s: string) => `2026-11-1${s}Z`;
const jl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
/** `stamp: 2` gives the versioned shape this project wrote; `stamp: 0` the unversioned one of the earlier system. */
const stampOf = (stamp: 0 | 2) => (o: object) => (stamp ? { schemaVersion: stamp, ...o } : o);

const q = (id: string, over: Partial<Question> = {}): Question => ({
	id, kind: "product", title: `Question ${id}`, context: "ctx", options: [{ label: "Photo first" }, { label: "Text first" }], recommended: 0,
	proposedRuling: "Lead with a photo", thread: "Mobile app", server: "main", threadId: "thread-1", createdAt: "2026-11-09T10:00:00.000Z", ...over,
});
const ans = (id: string, over: Partial<Answer> = {}): Answer => ({ choice: 0, label: "Photo first", by: "page", t: "2026-11-09T11:00:00.000Z", deliveryId: answerDeliveryId(id), ...over });

/**
 * An old install, split into a config directory and a cache directory. Seven questions in every state the old queue had, and
 * every other file the old layout kept.
 */
function oldInstall(stamp: 0 | 2) {
	const root = scratch();
	const conf = `${root}/conf`, cache = `${root}/cache`;
	for (const d of [conf, cache, `${cache}/woken`, `${cache}/relayed`, `${cache}/evidence/Q-aaaa1`, `${cache}/afk-archive`]) mkdirSync(d, { recursive: true });
	const S = stampOf(stamp);
	const claim = (id: string, message: string, extra: object = {}) => JSON.stringify(stamp ? { schemaVersion: stamp, owner: "page", item: id, deliveryId: answerDeliveryId(id), message, t: "2026-11-09T11:00:01.000Z", answer: ans(id), ...extra } : { v: 2, owner: "page", item: id, deliveryId: answerDeliveryId(id), message, t: "2026-11-09T11:00:01.000Z", answer: ans(id), ...extra });
	const routed = q("Q-ffff6", { options: [{ label: "Ship it", route: "thread", relay: "Do it." }, { label: "Hold" }] });
	const events = [
		{ type: "ask", t: T("9T10:00:00"), item: q("Q-aaaa1", { evidence: [{ type: "image", path: "a.png", caption: "before" }, { type: "link", url: "https://example.com/x" }] }) },
		{ type: "ask", t: T("9T10:00:01"), item: q("Q-bbbb2") }, { type: "answer", t: T("9T11:00:00"), id: "Q-bbbb2", answer: ans("Q-bbbb2") }, { type: "delivered", t: T("9T11:00:05"), id: "Q-bbbb2", deliveryId: answerDeliveryId("Q-bbbb2") },
		{ type: "ask", t: T("9T10:00:02"), item: q("Q-cccc3") }, { type: "answer", t: T("9T11:00:00"), id: "Q-cccc3", answer: ans("Q-cccc3", { note: "go" }) },
		{ type: "ask", t: T("9T10:00:03"), item: q("Q-dddd4") }, { type: "not-now", t: T("9T12:00:00"), id: "Q-dddd4" },
		{ type: "ask", t: T("9T10:00:04"), item: q("Q-eeee5") }, { type: "answered-on-card", t: T("9T12:00:00"), id: "Q-eeee5", requestId: "req-1" },
		{ type: "ask", t: T("9T10:00:05"), item: routed }, { type: "answer", t: T("9T11:00:00"), id: "Q-ffff6", answer: ans("Q-ffff6", { label: "Ship it" }) },
		{ type: "relayed", t: T("9T11:00:02"), id: "Q-ffff6", choice: "Ship it", server: "main", threadId: "thread-1", outcome: "delivered", detail: "sent" }, { type: "delivered", t: T("9T11:00:03"), id: "Q-ffff6", deliveryId: answerDeliveryId("Q-ffff6") },
		{ type: "ask", t: T("9T10:00:06"), item: q("Q-gggg7") }, { type: "answer", t: T("9T11:00:00"), id: "Q-gggg7", answer: ans("Q-gggg7") },
		{ type: "ask", t: T("9T10:00:07"), item: q("Q-first8") }, { type: "ask", t: T("9T10:00:08"), item: q("Q-first8", { title: "a later ask of the same id is ignored" }) },
	].map(S);
	writeFileSync(`${cache}/queue.jsonl`, jl(events) + '{"type":"ask","t":"tor');
	writeFileSync(`${cache}/woken/Q-bbbb2`, claim("Q-bbbb2", "wake text B"));
	writeFileSync(`${cache}/woken/Q-cccc3`, claim("Q-cccc3", "wake text C", { answer: ans("Q-cccc3", { note: "go" }) }));
	writeFileSync(`${cache}/woken/Q-ffff6`, claim("Q-ffff6", "fallback F", { relay: { server: "main", threadId: "thread-1", message: "relay F" } }));
	writeFileSync(`${cache}/woken/Q-gggg7`, "page");
	writeFileSync(`${cache}/woken/Q-orphan`, claim("Q-orphan", "no question"));
	writeFileSync(`${cache}/relayed/Q-ffff6`, JSON.stringify({ t: T("9T11:00:01.000") }));
	writeFileSync(`${cache}/relayed/Q-ffff6.result`, JSON.stringify({ outcome: "delivered", detail: "sent to main:thread-1", t: T("9T11:00:02.000") }));
	writeFileSync(`${cache}/evidence/Q-aaaa1/a.png`, "png");
	writeFileSync(`${conf}/rulings.jsonl`, jl([
		{ id: "R1", date: "2026-11-01", words: "w1", decides: "Merge conflicts are the Steward's.", source: "chat", status: "in-force", confirmed: true, confirmedAt: T("1T09:00:00"), history: [{ t: T("1T09:00:00"), what: "stated in chat" }] },
		{ id: "R2", date: "2026-11-02", words: "w2", decides: "Gates like this one", source: "card", status: "proposed", confirmed: false, item: "Q-bbbb2" },
		{ id: "R10", date: "2026-11-03", words: "w3", decides: "Retired one", source: "card", status: "retired", confirmed: true, retiredAt: T("3T10:00:00"), retiredHow: "only this once" },
	].map(S)));
	writeFileSync(`${conf}/butlers.jsonl`, jl([{ id: "B-1", thread: "t1", machine: "m", model: "x", scope: "s", started: T("1T10:00:00") }, { id: "B-2", thread: "t2", machine: "m", model: "x", scope: "s", started: T("1T11:00:00") }, { id: "B-1", stopped: T("1T12:00:00"), reason: "done" }].map(S)));
	writeFileSync(`${conf}/afk.json`, JSON.stringify(S({ enteredAt: T("1T20:00:00"), words: "back at nine", expectedReturn: T("2T09:00:00") })));
	writeFileSync(`${cache}/afk-archive/2026-10-30.json`, JSON.stringify({ enteredAt: "2026-10-30T20:00:00Z", words: "earlier" }));
	writeFileSync(`${cache}/decisions.jsonl`, jl([
		{ t: T("1T08:00:00"), thread: "a", decision: "took it", ruling: "R1: why", rulingIds: ["R1"], ref: null },
		{ t: T("1T09:00:00"), thread: "b", decision: "free text", ruling: "just words", ref: "x" },
	].map(S)));
	const held = [{ t: T("1T10:00:00.000"), thread: "Mobile", what: "approve the flush", taken: "parked", requestId: "r1" }, { t: T("1T11:00:00.000"), thread: "Web", what: "pick a palette", item: "Q-aaaa1" }].map(S);
	writeFileSync(`${cache}/held.jsonl`, jl(held));
	const h0 = held[0] as { t: string; server?: string; thread: string; requestId?: string; what: string };
	const hid = createHash("sha256").update([h0.t, h0.server ?? "", h0.thread, h0.requestId ?? "", h0.what].join("\n")).digest("hex").slice(0, 8);
	writeFileSync(`${cache}/held-closed.jsonl`, jl([S({ t: T("1T10:30:00.000"), id: hid, how: "answered in the thread" })]));
	writeFileSync(`${cache}/held-wakes.json`, JSON.stringify(S({ items: [{ deliveryId: "held-1", message: "m1", queuedAt: NOW - 1000, kind: "turn_ended", thread: "t1" }, { deliveryId: "held-landed", message: "m2", queuedAt: NOW - 2000 }], inflight: { id: "x", members: [], owner: "daemon", pid: 1, at: 1 } })));
	writeFileSync(`${cache}/held-wakes.landed.jsonl`, jl([{ deliveryId: "held-landed", t: NOW - 500 }, { deliveryId: answerDeliveryId("Q-bbbb2"), t: NOW - 400 }, { deliveryId: "ancient", t: NOW - 40 * 24 * 3600_000 }]) + "{torn");
	writeFileSync(`${cache}/pending-wakes.queue-web.landed.jsonl`, "");
	writeFileSync(`${cache}/pending-wakes.json`, JSON.stringify([{ deliveryId: "pending-1", message: "p1", queuedAt: NOW - 3000 }, { deliveryId: "held-landed", message: "again", queuedAt: NOW - 3000 }]));
	writeFileSync(`${cache}/pending-wakes.queue-web.json`, JSON.stringify([{ deliveryId: answerDeliveryId("Q-cccc3"), message: "wake text C", queuedAt: NOW - 4000 }]));
	writeFileSync(`${cache}/events.jsonl`, [{ t: T("2T10:00:00.000"), event: "fire", kind: "turn_ended" }, { t: T("2T10:00:01.000"), src: "queue-web", event: "answered", id: "Q-bbbb2" }, { t: T("2T10:00:02.000"), event: "delivered", deliveryId: "held-1", http: 202 }].map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n");
	writeFileSync(`${cache}/fired.json`, JSON.stringify(["req:r1", "report:t1:0", "t1:needs_input:r2"]));
	writeFileSync(`${cache}/sweep-state.json`, JSON.stringify(S({ lastAt: NOW - 1000, lastFullAt: NOW - 5000, seen: ["disk:disk-low", "ci:pr:7:abc", "orphan-no-colon"], seeded: true })));
	writeFileSync(`${cache}/rights-sent.json`, JSON.stringify(S({ hash: "a".repeat(64), used: 80000 })));
	writeFileSync(`${cache}/steward-health.json`, JSON.stringify(S({ at: T("2T10:00:00.000"), verdict: "WATCH", report: "r", replies: 0, breaks: 0, selfReads: 0, threadRereads: 0, elevated: [], unknown: [] })));
	writeFileSync(`${cache}/heartbeat.json`, JSON.stringify({ t: T("2T10:00:00.000"), away: false, deliveryFailures: 0, servers: [] }));
	// Things that are not state: config, the hand-off, and a stray scratch file.
	writeFileSync(`${conf}/servers.json`, "[]");
	writeFileSync(`${conf}/decision-rights.md`, "rights");
	writeFileSync(`${cache}/steward-brief.md`, "brief");
	writeFileSync(`${cache}/notes-from-someone.md`, "scratch");
	return { root, conf, cache };
}

/** Every file under a directory, with a hash of its bytes: what "never changes a source" is measured against. */
function tree(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string) => { for (const n of readdirSync(d).sort()) { const p = `${d}/${n}`; if (statSync(p).isDirectory()) { out[`${p}/`] = "dir"; walk(p); } else out[p] = `${statSync(p).size}:${createHash("sha1").update(readFileSync(p)).digest("hex")}:${statSync(p).mtimeMs}`; } };
	walk(dir);
	return out;
}

/** The database's content as plain data, for comparing two states. */
function dump(s: Store) {
	return JSON.stringify({
		items: s.items.list().map(({ id: _i, ...rest }) => rest),
		claims: s.claims.list(QUEUE), relays: [...s.claims.listRelays(QUEUE)], evidence: [...s.evidence.listAll(QUEUE)],
		rulings: s.rulings.list(), decisions: s.decisions.list(), butlers: s.butlers.list(), away: s.away.current(),
		outbox: s.wakes.rows("all"), held: s.wakes.held(), events: s.events.query(),
		state: ["sweep-clock", "rights-sent", "steward-health", "heartbeat"].map((k) => s.state.get(k)),
	});
}

describe("the versioned files this project wrote", () => {
	test("every kind of record lands in its table", () => {
		const w = oldInstall(2);
		const s = memStore();
		const report = importLegacy(s, [w.conf, w.cache], { now: NOW });

		// The queue, in every state.
		const st = questionStates(s);
		expect([...st.keys()].sort()).toEqual(["Q-aaaa1", "Q-bbbb2", "Q-cccc3", "Q-dddd4", "Q-eeee5", "Q-ffff6", "Q-first8", "Q-gggg7"]);
		expect(st.get("Q-aaaa1")).toMatchObject({ status: "open", delivered: false, evidence: [{ type: "image", path: "a.png", caption: "before" }, { type: "link", url: "https://example.com/x" }] });
		expect(st.get("Q-bbbb2")).toMatchObject({ status: "answered", delivered: true, answer: { label: "Photo first" } });
		expect(readClaim(s, "Q-bbbb2")).toMatchObject({ owner: "page", message: "wake text B", deliveryId: "answer:item:Q-bbbb2" });
		expect(st.get("Q-cccc3")).toMatchObject({ status: "answered", delivered: false, answer: { note: "go" } });
		expect(st.get("Q-dddd4")).toMatchObject({ status: "open", notNowAt: T("9T12:00:00") });
		expect(s.items.get(QUEUE, "Q-dddd4")?.status).toBe("acknowledged");
		expect(st.get("Q-eeee5")).toMatchObject({ status: "answered-on-card" });
		expect(st.get("Q-ffff6")).toMatchObject({ status: "answered", delivered: true, relay: { outcome: "delivered" } });
		expect(readRelay(s, "Q-ffff6")).toMatchObject({ started: true, outcome: "delivered", detail: "sent to main:thread-1" });
		expect(readClaim(s, "Q-ffff6")).toMatchObject({ relay: { message: "relay F" } });
		expect(st.get("Q-first8")!.title).toBe("Question Q-first8");
		// The old owner-only claim file carried no wake: it was rebuilt from the answer, and is still to be sent.
		expect(st.get("Q-gggg7")).toMatchObject({ status: "answered", delivered: false });
		expect(readClaim(s, "Q-gggg7")!.message).toStartWith("[chamberlain] answer: ");
		expect(readClaim(s, "Q-orphan")).toBeUndefined();

		expect(readRulings(s).map((x) => [x.id, x.status, x.confirmed])).toEqual([["R1", "in-force", true], ["R2", "proposed", false], ["R10", "retired", true]]);
		expect(readRulings(s)[0]!.history).toEqual([{ t: T("1T09:00:00"), what: "stated in chat" }]);
		expect(s.butlers.list().map((b) => [b.id, b.stopped, b.reason])).toEqual([["B-1", T("1T12:00:00"), "done"], ["B-2", undefined, undefined]]);
		expect(s.away.current()).toEqual({ enteredAt: T("1T20:00:00"), words: "back at nine", expectedReturn: T("2T09:00:00") });
		expect(s.decisions.list().map((d) => [d.thread, d.rulingIds])).toEqual([["a", ["R1"]], ["b", undefined]]);
		// Held for the return: the closed one is resolved, the other still waits, and keeps its link to its question.
		expect(heldOpen(s).map((h) => h.what)).toEqual(["pick a palette"]);
		expect(s.items.list({ source: "held" })).toHaveLength(2);
		expect(s.items.list({ source: "held", status: "triggered" })[0]!.subject).toEqual({ kind: "question", id: "Q-aaaa1" });
		// Wakes: a delivered one is never pending or held again; an older-than-30-days landing is not worth keeping.
		expect(["held-landed", answerDeliveryId("Q-bbbb2")].map((id) => s.wakes.isDelivered(id))).toEqual([true, true]);
		expect(s.wakes.isDelivered("ancient")).toBe(false);
		// Both old owners' pending wakes are pending rows now: one relay sends them all.
		expect(s.wakes.rows().map((x) => x.deliveryId)).toEqual(["pending-1", answerDeliveryId("Q-cccc3")]);
		expect(s.wakes.held().map((i) => i.deliveryId)).toEqual(["held-1"]);
		// Each was composed for the old system's Steward, whatever rights line its text carries: stamped legacy, so the relay sends the full
		// rights ahead of it, and its text is kept as it was.
		const legacy = [{ hash: "", legacy: "unstamped" as const }];
		expect([...s.wakes.rows().map((x) => x.rights), ...s.wakes.held().map((i) => i.rights)]).toEqual([legacy, legacy, legacy]);
		// The event log, with its torn line skipped.
		expect(s.events.query().map((e) => e.event)).toEqual(["fire", "answered", "delivered"]);
		expect(s.events.query({ src: "queue-web" })[0]).toMatchObject({ id: "Q-bbbb2" });
		// What fired, the sweep clock and what it had seen, as items.
		expect(s.items.list({ source: "notification-log" }).map((i) => [i.dedupKey, i.status, i.notificationCount])).toEqual([["req:r1", "triggered", 1], ["report:t1:0", "triggered", 1], ["t1:needs_input:r2", "triggered", 1]]);
		expect(s.state.get("sweep-clock")).toEqual({ lastAt: NOW - 1000, lastFullAt: NOW - 5000, seeded: true });
		expect(s.items.list({ source: "check:disk" })[0]).toMatchObject({ dedupKey: "disk-low", status: "acknowledged", kind: "finding" });
		expect(s.items.get("check:ci", "pr:7:abc")?.status).toBe("acknowledged");
		expect(s.state.get("rights-sent")).toEqual({ hash: "a".repeat(64), used: 80000 });
		expect(s.state.get("steward-health")).toMatchObject({ verdict: "WATCH" });
		expect(s.state.get("heartbeat")).toMatchObject({ away: false });

		// The report says what it did.
		expect(report.counts.questions).toEqual({ read: 8, imported: 8, present: 0 });
		expect(report.counts.rulings).toEqual({ read: 3, imported: 3, present: 0 });
		expect(report.counts.events).toEqual({ read: 3, imported: 3, present: 0 });
		expect(report.tornLines).toMatchObject({ "queue.jsonl": 1, "events.jsonl": 1, "held-wakes.landed.jsonl": 1 });
		expect(report.skipped.map((x) => x.what)).toEqual(expect.arrayContaining(["woken/Q-orphan", "pending wake held-landed", "held wake held-landed"]));
		expect(report.notes.join("\n")).toContain("Q-gggg7: an old-format claim file carried no wake");
		expect(report.ignored).toContain("notes-from-someone.md");
		expect(report.ignored).not.toContain("servers.json");
		expect(formatReport(report)).toContain("No source file was changed or deleted.");
	});

	test("it is idempotent: a second run imports nothing and the database is unchanged", () => {
		const w = oldInstall(2);
		const s = memStore();
		importLegacy(s, [w.conf, w.cache], { now: NOW });
		const first = dump(s);
		const again = importLegacy(s, [w.conf, w.cache], { now: NOW + 60_000 });
		expect(dump(s)).toBe(first);
		for (const [what, c] of Object.entries(again.counts)) expect([what, c.imported]).toEqual([what, 0]);
		expect(again.counts.questions!.present).toBe(8);
		// And a third, to be sure a rerun of a rerun is also a no-op.
		importLegacy(s, [w.conf, w.cache], { now: NOW + 120_000 });
		expect(dump(s)).toBe(first);
	});

	test("it reads and never writes: every source file and folder is byte for byte as it was, and nothing is added or removed", () => {
		const w = oldInstall(2);
		const before = tree(w.root);
		importLegacy(memStore(), [w.conf, w.cache], { now: NOW });
		expect(tree(w.root)).toEqual(before);
	});

	test("a dry run writes nothing, and says it is a dry run", () => {
		const w = oldInstall(2);
		const s = memStore();
		const r = importLegacy(s, [w.conf, w.cache], { now: NOW, dryRun: true });
		expect(s.items.list()).toEqual([]);
		expect(s.rulings.list()).toEqual([]);
		expect(s.events.count()).toBe(0);
		expect(r.counts.questions!.read).toBe(8);
		expect(r.notes.join(" ")).toContain("dry run");
	});

	test("the imported database drives the page: recovery sends exactly the wakes that were never sent, once", async () => {
		const w = oldInstall(2);
		const s = memStore();
		importLegacy(s, [w.conf, w.cache], { now: NOW });
		const sent: { deliveryId: string; message: string }[] = [];
		const wake = fetchWake(() => "http://webhook.test/wake", (async (_u: string, init: RequestInit) => { sent.push(JSON.parse(String(init.body))); return new Response(null, { status: 202 }); }) as unknown as typeof fetch);
		const { relay } = testRelay(s, wake);
		const app = createApp({ store: s, state: w.cache, log: () => {}, hosts: ["127.0.0.1:3790"], staticDir: w.root });
		await app.recover();
		await app.idle();
		await relay.pass();
		// The daemon's pending-1 and C (pending under the page's name) go as rows; G, the rebuilt claim, goes from its claim; B, F and the
		// delivered ones do not go. The held wake waits for the Steward to be idle, and the test's Steward is.
		expect(sent.map((x) => x.deliveryId).sort()).toEqual([answerDeliveryId("Q-cccc3"), answerDeliveryId("Q-gggg7"), "held-1", "pending-1"].sort());
		await app.recover();
		await app.idle();
		await relay.pass();
		expect(sent).toHaveLength(4);
		expect(getQuestion(s, "Q-cccc3")!.delivered).toBe(true);
		expect(getQuestion(s, "Q-gggg7")!.delivered).toBe(true);
		expect(withDeliveryId(readClaim(s, "Q-gggg7")!.message, answerDeliveryId("Q-gggg7"))).toBe(sent.find((x) => x.deliveryId === answerDeliveryId("Q-gggg7"))!.message);
		expect(pageClaim(q("Q-gggg7"), ans("Q-gggg7")).message).toBe(readClaim(s, "Q-gggg7")!.message);
	});
});

describe("the unversioned files the earlier system wrote", () => {
	test("records with no schemaVersion, a claim's `v: 2`, and an away-era sweep clock all import", () => {
		const w = oldInstall(0);
		// The away-only days' sweep file: its gap is not news, so the clock starts from now.
		writeFileSync(`${w.cache}/sweep-state.json`, JSON.stringify({ away: "2026-11-05T03:15:20.855Z", lastAt: 5, lastFullAt: 3, seen: ["gate:x"], seeded: true }));
		const s = memStore();
		importLegacy(s, [w.conf, w.cache], { now: NOW });
		expect(readClaim(s, "Q-bbbb2")).toMatchObject({ owner: "page", message: "wake text B" });
		expect(readClaim(s, "Q-bbbb2") as object).not.toHaveProperty("v");
		expect(getQuestion(s, "Q-bbbb2")).toMatchObject({ status: "answered", delivered: true });
		expect(readRulings(s)).toHaveLength(3);
		expect(readRulings(s)[0]).not.toHaveProperty("schemaVersion");
		expect(s.state.get("sweep-clock")).toEqual({ lastAt: NOW, lastFullAt: 3, seeded: true });
		expect(s.items.get("check:gate", "x")?.status).toBe("acknowledged");
		expect(s.away.current()?.words).toBe("back at nine");
	});

	test("both shapes give the same database", () => {
		const a = memStore(), b = memStore();
		importLegacy(a, oneRoot(oldInstall(2)), { now: NOW });
		importLegacy(b, oneRoot(oldInstall(0)), { now: NOW });
		const norm = (x: Store) => JSON.parse(dump(x)) as Record<string, unknown>;
		expect(norm(a)).toEqual(norm(b));
	});
});

/** The same install as one directory holding both kinds of file (the earlier system's flat layouts and copies). */
function oneRoot(w: { conf: string; cache: string; root: string }): string[] { return [w.root]; }

describe("layouts", () => {
	test("one directory with conf/ and cache/ inside, and a flat directory with everything in it, read the same as two directories", () => {
		const w = oldInstall(2);
		const flat = scratch();
		for (const dir of [w.conf, w.cache]) cpSync(dir, flat, { recursive: true });
		const [two, nested, flatStore] = [memStore(), memStore(), memStore()];
		importLegacy(two, [w.conf, w.cache], { now: NOW });
		importLegacy(nested, [w.root], { now: NOW });
		importLegacy(flatStore, [flat], { now: NOW });
		expect(dump(nested)).toBe(dump(two));
		expect(dump(flatStore)).toBe(dump(two));
	});

	test("nothing to import is a report that says so, and a missing directory is not an error to the library", () => {
		const s = memStore();
		const r = importLegacy(s, [scratch()], { now: NOW });
		expect(r.counts).toEqual({});
		expect(formatReport(r)).toContain("Nothing to import was found.");
	});
});

describe("what it refuses and what it tolerates", () => {
	test("a record from a newer Chamberlain stops it before anything is written", () => {
		const w = oldInstall(2);
		writeFileSync(`${w.conf}/rulings.jsonl`, jl([{ schemaVersion: 2, id: "R1", date: "d", words: "w", decides: "d", source: "chat", status: "in-force", confirmed: true }, { schemaVersion: 9, id: "R2" }]));
		const s = memStore();
		expect(() => importLegacy(s, [w.conf, w.cache], { now: NOW })).toThrow(SchemaTooNewError);
		expect(() => importLegacy(s, [w.conf, w.cache], { now: NOW })).toThrow(/rulings\.jsonl has schemaVersion 9/);
		expect(s.items.list()).toEqual([]);
		expect(s.rulings.list()).toEqual([]);
		// A newer claim file too.
		const w2 = oldInstall(2);
		writeFileSync(`${w2.cache}/woken/Q-bbbb2`, JSON.stringify({ schemaVersion: 9, owner: "page", item: "Q-bbbb2", deliveryId: "d", message: "m", t: "t" }));
		expect(() => importLegacy(memStore(), [w2.conf, w2.cache])).toThrow(/woken\/Q-bbbb2 has schemaVersion 9/);
	});

	test("a failure part way leaves the database as it was (the import is one transaction)", () => {
		const w = oldInstall(2);
		const s = memStore();
		// Force a failure after the queue is written: a held record whose key collides in a way the store refuses.
		const real = s.rulings.save;
		(s.rulings as { save: typeof real }).save = () => { throw Error("disk full"); };
		expect(() => importLegacy(s, [w.conf, w.cache], { now: NOW })).toThrow("disk full");
		expect(s.items.list()).toEqual([]);
		expect(s.wakes.isDelivered("held-landed")).toBe(false);
		(s.rulings as { save: typeof real }).save = real;
		importLegacy(s, [w.conf, w.cache], { now: NOW });
		expect(s.items.list({ source: QUEUE })).toHaveLength(8);
	});

	test("a ruling already in the database with different content is kept as it is, and reported", () => {
		const w = oldInstall(2);
		const s = memStore();
		s.rulings.save({ id: "R1", date: "2026-11-01", words: "w1", decides: "Edited in the new system.", source: "chat", status: "in-force", confirmed: true, history: [] });
		const r = importLegacy(s, [w.conf, w.cache], { now: NOW });
		expect(readRulings(s)[0]!.decides).toBe("Edited in the new system.");
		expect(r.skipped).toContainEqual({ what: "ruling R1", why: "already in the database with different content: the database's copy was kept" });
	});

	describe("rulings with the hygiene fields (the earlier system's newer records)", () => {
		/** rulings.jsonl as the earlier system now writes it: unversioned, with its own `legacy` key, and every hygiene field. */
		const NEW_SHAPE: (Ruling & { legacy?: string })[] = [
			{ id: "R1", date: "2026-11-01", words: "w1", decides: "A standing rule.", source: "chat", status: "in-force", confirmed: true, confirmedAt: T("1T09:00:00"), legacy: "9f2c4a1b7d3e5a60:1", history: [{ t: T("1T09:00:00"), what: "stated in chat" }] },
			{ id: "R2", date: "2026-11-02", words: "w2", decides: "Hold the deploy for this launch.", source: "card", status: "in-force", confirmed: true, confirmedAt: T("2T09:00:00"), item: "Q-bbbb2", expires: "2026-11-20", until: "the V2 launch", history: [] },
			{ id: "R3", date: "2026-11-03", words: "w3", decides: "Replaces R5 and R6.", source: "chat", status: "in-force", confirmed: true, confirmedAt: T("3T09:00:00"), supersedes: ["R5", "R6"], expires: "2026-12-01T09:00:00Z", history: [] },
			{ id: "R4", date: "2026-11-04", words: "w4", decides: "Said twice.", source: "chat", status: "retired", confirmed: true, retiredAt: T("4T10:00:00"), retiredHow: "duplicate", retiredWhy: "same rule as R1", supersededBy: "R1", legacy: "aaaa:1", history: [{ t: T("4T10:00:00"), what: "duplicate (R1): same rule as R1" }] },
			{ id: "R5", date: "2026-11-05", words: "w5", decides: "Old one.", source: "chat", status: "retired", confirmed: true, retiredAt: T("3T09:00:00"), retiredHow: "superseded", retiredWhy: "replaced by R3", supersededBy: "R3", history: [] },
			{ id: "R6", date: "2026-11-06", words: "w6", decides: "Older one.", source: "card", status: "retired", confirmed: false, retiredAt: T("5T10:00:00"), retiredHow: "expired", retiredWhy: "the launch is over", expires: "2026-11-05", history: [] },
			{ id: "R7", date: "2026-11-07", words: "w7", decides: "Already in the rights file.", source: "chat", status: "retired", confirmed: true, retiredAt: T("6T10:00:00"), retiredHow: "repeat", retiredWhy: "decision-rights.md says it", history: [] },
			{ id: "R8", date: "2026-11-08", words: "w8", decides: "Once.", source: "card", status: "retired", confirmed: true, retiredAt: T("7T10:00:00"), retiredHow: "only this once", history: [] },
		];
		const install = (rows: object[]) => {
			const root = scratch();
			const conf = `${root}/conf`, cache = `${root}/cache`;
			mkdirSync(conf, { recursive: true }); mkdirSync(cache, { recursive: true });
			writeFileSync(`${conf}/rulings.jsonl`, jl(rows));
			return { conf, cache };
		};

		test("round trip: every field of every record comes across, retired-with-reason records included, and the earlier system's bookkeeping does not", () => {
			const w = install(NEW_SHAPE);
			const s = memStore();
			const r = importLegacy(s, [w.conf, w.cache], { now: NOW });
			expect(r.counts.rulings).toEqual({ read: 8, imported: 8, present: 0 });
			expect(r.skipped).toEqual([]);
			const got = readRulings(s);
			expect(got).toEqual(NEW_SHAPE.map(({ legacy: _l, ...rest }) => rest));
			expect(got.find((x) => x.id === "R2")).toMatchObject({ expires: "2026-11-20", until: "the V2 launch", item: "Q-bbbb2" });
			expect(got.find((x) => x.id === "R3")).toMatchObject({ supersedes: ["R5", "R6"], expires: "2026-12-01T09:00:00Z" });
			expect(got.map((x) => [x.id, x.retiredHow, x.retiredWhy, x.supersededBy])).toEqual([
				["R1", undefined, undefined, undefined], ["R2", undefined, undefined, undefined], ["R3", undefined, undefined, undefined],
				["R4", "duplicate", "same rule as R1", "R1"], ["R5", "superseded", "replaced by R3", "R3"], ["R6", "expired", "the launch is over", undefined],
				["R7", "repeat", "decision-rights.md says it", undefined], ["R8", "only this once", undefined, undefined],
			]);
			for (const x of got) expect(x).not.toHaveProperty("legacy");
		});

		test("what is imported behaves: R2 is in force until its date passes, R3 retired nothing by itself (its targets arrive already retired)", () => {
			const w = install(NEW_SHAPE);
			const s = memStore();
			importLegacy(s, [w.conf, w.cache], { now: NOW });
			const ids = (nowMs: number) => inForceNow(readRulings(s), nowMs).map((x) => x.id);
			expect(ids(Date.parse("2026-11-12T00:00:00Z"))).toEqual(["R1", "R2", "R3"]);
			expect(ids(Date.parse("2026-11-21T00:00:00Z"))).toEqual(["R1", "R3"]);
			expect(ids(Date.parse("2026-12-02T00:00:00Z"))).toEqual(["R1"]);
		});

		test("importing again imports nothing, and reports no difference between the file and the database", () => {
			const w = install(NEW_SHAPE);
			const s = memStore();
			importLegacy(s, [w.conf, w.cache], { now: NOW });
			const first = JSON.stringify(readRulings(s));
			const again = importLegacy(s, [w.conf, w.cache], { now: NOW });
			expect(again.counts.rulings).toEqual({ read: 8, imported: 0, present: 8 });
			expect(again.skipped).toEqual([]);
			expect(JSON.stringify(readRulings(s))).toBe(first);
		});

		test("the versioned shape this project writes carries the same fields", () => {
			const w = install(NEW_SHAPE.map((x) => ({ schemaVersion: 2, ...x })));
			const s = memStore();
			importLegacy(s, [w.conf, w.cache], { now: NOW });
			expect(readRulings(s)).toEqual(NEW_SHAPE.map(({ legacy: _l, ...rest }) => rest));
		});

		test("a malformed hygiene field is left out and noted; it never stops the import or changes what the record says", () => {
			const w = install([
				{ id: "R1", date: "d", words: "w", decides: "d", source: "chat", status: "retired", confirmed: true, retiredHow: "vanished", supersededBy: "somebody", supersedes: "R2", history: [] },
				{ id: "R2", date: "d", words: "w2", decides: "d2", source: "chat", status: "in-force", confirmed: true, expires: "next week", supersedes: ["R1", 7], history: [] },
				{ id: "R3", date: "d", words: "w3", decides: "d3", source: "chat", status: "in-force", confirmed: true, expires: "2026-12-01T09:00:00", history: [] },
			]);
			const s = memStore();
			const r = importLegacy(s, [w.conf, w.cache], { now: NOW });
			expect(r.counts.rulings).toEqual({ read: 3, imported: 3, present: 0 });
			const got = readRulings(s);
			expect(got[0]).not.toHaveProperty("retiredHow");
			expect(got[0]).not.toHaveProperty("supersededBy");
			expect(got[0]).not.toHaveProperty("supersedes");
			expect(got[1]).not.toHaveProperty("supersedes");
			expect(got[1]!.expires).toBe("next week");
			expect(r.notes).toContain('R1: retiredHow "vanished" is not one this version knows; it was not imported');
			expect(r.notes).toContain('R1: supersededBy "somebody" is not a ruling id; it was not imported');
			expect(r.notes).toContain("R1: supersedes is not a list of ruling ids; it was not imported");
			expect(r.notes).toContain("R2: supersedes is not a list of ruling ids; it was not imported");
			// An expiry that cannot be read counts as passed, so it leaves force rather than staying in it by mistake; the report says so.
			expect(r.notes).toContain('R2: expires "next week" is not an ISO date or a date-time with a zone, so it counts as already expired');
			expect(r.notes).toContain('R3: expires "2026-12-01T09:00:00" is not an ISO date or a date-time with a zone, so it counts as already expired');
			expect(inForceNow(got, NOW).map((x) => x.id)).toEqual([]);
		});

		test("a record already in the database with the same fields is the same record, whatever the order of its keys", () => {
			const w = install(NEW_SHAPE);
			const s = memStore();
			const { legacy: _l, ...r2 } = NEW_SHAPE[1]!;
			s.rulings.save(r2 as never);
			const r = importLegacy(s, [w.conf, w.cache], { now: NOW });
			expect(r.counts.rulings).toEqual({ read: 8, imported: 7, present: 1 });
			expect(r.skipped).toEqual([]);
		});

		test("a dry run counts the rulings and writes nothing", () => {
			const w = install(NEW_SHAPE);
			const s = memStore();
			const r = importLegacy(s, [w.conf, w.cache], { now: NOW, dryRun: true });
			expect(r.counts.rulings).toEqual({ read: 8, imported: 0, present: 0 });
			expect(readRulings(s)).toEqual([]);
		});
	});

	test("an unreadable JSON document is counted and skipped, and the rest still imports", () => {
		const w = oldInstall(2);
		writeFileSync(`${w.cache}/fired.json`, "[not json");
		writeFileSync(`${w.cache}/sweep-state.json`, "{");
		const s = memStore();
		const r = importLegacy(s, [w.conf, w.cache], { now: NOW });
		expect(r.tornLines).toMatchObject({ "fired.json": 1, "sweep-state.json": 1 });
		expect(s.items.list({ source: "wake" })).toEqual([]);
		expect(s.items.list({ source: QUEUE })).toHaveLength(8);
	});

	test("an untrustworthy rights record is reported, so the next wake sends the rights in full", () => {
		const w = oldInstall(2);
		writeFileSync(`${w.cache}/rights-sent.json`, JSON.stringify({ hash: "short" }));
		const s = memStore();
		const r = importLegacy(s, [w.conf, w.cache], { now: NOW });
		expect(s.state.get("rights-sent")).toBeUndefined();
		expect(r.skipped.map((x) => x.what)).toContain("rights-sent.json");
	});

	test("an import into a database that already holds newer work adds only what is missing", () => {
		const w = oldInstall(2);
		const s = memStore();
		importLegacy(s, [w.conf, w.cache], { now: NOW });
		s.rulings.save({ id: "R11", date: "2026-11-12", words: "new", decides: "made after", source: "chat", status: "in-force", confirmed: true, history: [] });
		s.events.append({ t: "2026-11-12T10:00:00.000Z", event: "fire" });
		const r = importLegacy(s, [w.conf, w.cache], { now: NOW });
		expect(readRulings(s).map((x) => x.id)).toEqual(["R1", "R2", "R10", "R11"]);
		expect(s.events.count()).toBe(4);
		expect(Object.values(r.counts).every((c) => c.imported === 0)).toBe(true);
	});
});

describe("the command line", () => {
	const run = async (args: string[], env: Record<string, string> = {}) => {
		const p = Bun.spawn([process.execPath, new URL("../cli/import.ts", import.meta.url).pathname, ...args], { env: { ...process.env, CHAMBERLAIN_CONF: "", CHAMBERLAIN_CACHE: "", LEGACY_WAKE_CONF: "", LEGACY_WAKE_CACHE: "", ...env }, stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited];
		return { out, err, code };
	};

	test("--from twice, --to and --report: imports into <to>/chamberlain.db, writes the report, leaves the sources alone", async () => {
		const w = oldInstall(2);
		const to = scratch();
		const before = tree(w.root);
		const r = await run(["--from", w.conf, "--from", w.cache, "--to", to, "--report", `${to}/report.json`]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("questions");
		expect(r.out).toContain("No source file was changed or deleted.");
		expect(tree(w.root)).toEqual(before);
		const s = openStore(dbPath(to));
		expect(s.items.list({ source: QUEUE })).toHaveLength(8);
		s.close();
		expect(JSON.parse(readFileSync(`${to}/report.json`, "utf8")).counts.questions).toEqual({ read: 8, imported: 8, present: 0 });
		// Idempotent through the command line too.
		const again = await run(["--from", w.conf, "--from", w.cache, "--to", to]);
		expect(again.code).toBe(0);
		expect(again.out).toMatch(/questions\s+read\s+8\s+imported\s+0\s+already there\s+8/);
	}, 30_000);

	test("--from-env reads the earlier system's LEGACY_WAKE_CONF and LEGACY_WAKE_CACHE, and Chamberlain's own names win when both are set", async () => {
		const w = oldInstall(0);
		const to = scratch();
		const r = await run(["--from-env", "--to", to], { LEGACY_WAKE_CONF: w.conf, LEGACY_WAKE_CACHE: w.cache });
		expect(r.code).toBe(0);
		expect(openStore(dbPath(to)).items.list({ source: QUEUE })).toHaveLength(8);
		const empty = scratch(), to2 = scratch();
		const own = await run(["--from-env", "--to", to2], { LEGACY_WAKE_CONF: w.conf, LEGACY_WAKE_CACHE: w.cache, CHAMBERLAIN_CONF: empty, CHAMBERLAIN_CACHE: empty });
		expect(own.code).toBe(0);
		expect(own.out).toContain("Nothing to import was found.");
	}, 30_000);

	test("--dry-run creates no database", async () => {
		const w = oldInstall(2);
		const to = scratch();
		const r = await run(["--from", w.conf, "--from", w.cache, "--to", to, "--dry-run"]);
		expect(r.code).toBe(0);
		expect(readdirSync(to)).toEqual([]);
		expect(r.out).toContain("dry run");
	}, 30_000);

	test("a newer record exits 3 with the reason and nothing imported; no --from, or a missing directory, exits 2", async () => {
		const w = oldInstall(2);
		writeFileSync(`${w.conf}/butlers.jsonl`, jl([{ schemaVersion: 9, id: "B-1" }]));
		const to = scratch();
		const r = await run(["--from", w.conf, "--from", w.cache, "--to", to]);
		expect(r.code).toBe(3);
		expect(r.err).toContain("butlers.jsonl has schemaVersion 9");
		expect(r.err).toContain("Nothing was imported.");
		const s = openStore(dbPath(to));
		expect(s.items.list()).toEqual([]);
		s.close();
		expect((await run([])).code).toBe(2);
		expect((await run(["--from", `${to}/nope`])).code).toBe(2);
	}, 30_000);
});

// ---- audit finding M2: every record shape is version-checked before anything is written, and the import is one transaction ----

describe("a record from a newer Chamberlain, in any shape, stops the import before it writes anything", () => {
	const NEWER = 999;
	// (Some fixture files end in a torn line with no newline, as a crash leaves them: start the new record on its own line.)
	const addLine = (file: string, rec: object) => (w: { conf: string; cache: string }) => writeFileSync(`${w.cache}/${file}`, readFileSync(`${w.cache}/${file}`, "utf8").replace(/\n?$/, "\n") + JSON.stringify(rec) + "\n");
	const rewrite = (file: string, edit: (text: string) => string) => (w: { conf: string; cache: string }) => { const p = `${w.cache}/${file}`; writeFileSync(p, edit(readFileSync(p, "utf8"))); };
	const SHAPES: [string, (w: { conf: string; cache: string }) => void][] = [
		["a queue event", addLine("queue.jsonl", { schemaVersion: NEWER, type: "ask", item: q("Q-newer1") })],
		["a claim file", (w) => writeFileSync(`${w.cache}/woken/Q-bbbb2`, JSON.stringify({ schemaVersion: NEWER, owner: "page", item: "Q-bbbb2", deliveryId: answerDeliveryId("Q-bbbb2"), message: "m", t: "2026-11-09T11:00:01.000Z" }))],
		["a relay's start record", (w) => writeFileSync(`${w.cache}/relayed/Q-bbbb2`, JSON.stringify({ schemaVersion: NEWER, t: "2026-11-09T11:00:01.000Z" }))],
		["a relay's result", (w) => writeFileSync(`${w.cache}/relayed/Q-ffff6.result`, JSON.stringify({ schemaVersion: NEWER, outcome: "delivered", detail: "sent", t: "2026-11-09T11:00:02.000Z" }))],
		["a ruling", (w) => writeFileSync(`${w.conf}/rulings.jsonl`, readFileSync(`${w.conf}/rulings.jsonl`, "utf8") + JSON.stringify({ schemaVersion: NEWER, id: "R99" }) + "\n")],
		["a butler line", (w) => writeFileSync(`${w.conf}/butlers.jsonl`, readFileSync(`${w.conf}/butlers.jsonl`, "utf8") + JSON.stringify({ schemaVersion: NEWER, id: "B-9" }) + "\n")],
		["a decision", addLine("decisions.jsonl", { schemaVersion: NEWER, t: "2026-11-11T08:00:00Z", thread: "a", decision: "d", ruling: "r", ref: null })],
		["a held record", addLine("held.jsonl", { schemaVersion: NEWER, t: "2026-11-11T12:00:00.000Z", thread: "x", what: "w" })],
		["a held closure", addLine("held-closed.jsonl", { schemaVersion: NEWER, t: "2026-11-11T12:30:00.000Z", id: "abcd1234", how: "h" })],
		["the held-wakes document", rewrite("held-wakes.json", (t) => JSON.stringify({ ...JSON.parse(t), schemaVersion: NEWER }))],
		["an item inside the held-wakes document", rewrite("held-wakes.json", (t) => { const d = JSON.parse(t); d.items[0].schemaVersion = NEWER; return JSON.stringify(d); })],
		["a held-wakes landing record", addLine("held-wakes.landed.jsonl", { schemaVersion: NEWER, deliveryId: "held-1", t: NOW - 100 })],
		["a daemon landing record", (w) => writeFileSync(`${w.cache}/pending-wakes.landed.jsonl`, JSON.stringify({ schemaVersion: NEWER, deliveryId: "pending-1", t: NOW - 100 }) + "\n")],
		["a page landing record", (w) => writeFileSync(`${w.cache}/pending-wakes.queue-web.landed.jsonl`, JSON.stringify({ schemaVersion: NEWER, deliveryId: "x", t: NOW - 100 }) + "\n")],
		["a pending wake", rewrite("pending-wakes.json", (t) => { const d = JSON.parse(t); d[0].schemaVersion = NEWER; return JSON.stringify(d); })],
		["a page's pending wake", rewrite("pending-wakes.queue-web.json", (t) => { const d = JSON.parse(t); d[0].schemaVersion = NEWER; return JSON.stringify(d); })],
		["an event", addLine("events.jsonl", { schemaVersion: NEWER, t: "2026-11-12T10:00:03.000Z", event: "fire" })],
		["the heartbeat", rewrite("heartbeat.json", (t) => JSON.stringify({ ...JSON.parse(t), schemaVersion: NEWER }))],
		["the sweep state", rewrite("sweep-state.json", (t) => JSON.stringify({ ...JSON.parse(t), schemaVersion: NEWER }))],
		["the rights record", rewrite("rights-sent.json", (t) => JSON.stringify({ ...JSON.parse(t), schemaVersion: NEWER }))],
		["the health record", rewrite("steward-health.json", (t) => JSON.stringify({ ...JSON.parse(t), schemaVersion: NEWER }))],
	];
	for (const [name, plant] of SHAPES) {
		test(`${name}: refused, and not one row is written (also in a dry run)`, () => {
			const w = oldInstall(2);
			plant(w);
			const s = memStore();
			const empty = dump(memStore());
			expect(() => importLegacy(s, [w.conf, w.cache], { now: NOW })).toThrow(SchemaTooNewError);
			expect(dump(s)).toBe(empty);
			expect(s.events.count()).toBe(0);
			expect(() => importLegacy(s, [w.conf, w.cache], { now: NOW, dryRun: true })).toThrow(SchemaTooNewError);
		});
	}
});

describe("the event log is part of the one transaction", () => {
	test("an event that cannot be written takes the whole import back with it (the main import used to be committed first)", () => {
		const w = oldInstall(2);
		const real = memStore();
		let appended = 0;
		const store: Store = { ...real, events: { ...real.events, append: (e, key) => { if (++appended === 2) throw Error("disk full"); real.events.append(e, key); } } };
		expect(() => importLegacy(store, [w.conf, w.cache], { now: NOW })).toThrow("disk full");
		// Not the questions, the rulings, the wakes nor the first event survived.
		expect(dump(real)).toBe(dump(memStore()));
		expect(real.events.count()).toBe(0);
		// And once it can be written, the whole thing goes in, once.
		const again = importLegacy(real, [w.conf, w.cache], { now: NOW });
		expect(again.counts.events!.imported).toBe(3);
		expect(real.items.list({ source: QUEUE })).not.toHaveLength(0);
	});

	test("the event log goes in with everything else, and a rerun adds none of it again", () => {
		const w = oldInstall(2);
		const s = memStore();
		importLegacy(s, [w.conf, w.cache], { now: NOW });
		const before = dump(s);
		const second = importLegacy(s, [w.conf, w.cache], { now: NOW });
		expect(second.counts.events).toEqual({ read: 3, imported: 0, present: 3 });
		expect(dump(s)).toBe(before);
	});
});
