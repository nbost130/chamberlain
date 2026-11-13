/**
 * The one-time importer: reads the old file layout into the database and changes nothing it reads.
 *
 * Before the database, Chamberlain (and the private system it was extracted from) kept its state in files: queue.jsonl,
 * rulings.jsonl, butlers.jsonl, the claim files in woken/, relayed/, the held-wake and pending-wake files and their delivered
 * ledgers, held.jsonl and held-closed.jsonl, decisions.jsonl, events.jsonl, fired.json, sweep-state.json, rights-sent.json,
 * steward-health.json, heartbeat.json, afk.json, with evidence under evidence/. This reads all of them, in both shapes: the
 * versioned files this project wrote (every record carries `schemaVersion`) and the unversioned ones the earlier system wrote
 * (no `schemaVersion`, a claim's `v: 2`, an owner-only claim file).
 *
 * Properties:
 *   - It reads only. No source file is ever written, moved or deleted.
 *   - It is idempotent: every record lands under a natural key, so running it again imports nothing new.
 *   - It is all or nothing: everything, the event log included, goes in ONE transaction, so a failure anywhere leaves the database as
 *     it was. Each event row is under a hash of its own line, so a rerun adds nothing.
 *   - A record from a newer Chamberlain (schemaVersion above this build's) stops it before it writes anything. EVERY supported record
 *     shape is checked, in the reading phase and before the transaction opens: the queue, claim files, relay files and their results,
 *     rulings, butlers, decisions, held records and closures, held and pending wakes, landing records, events, and every state document.
 *   - A torn or unreadable line is skipped and counted, never fatal.
 *   - It never invents a wake: a claim with no wake text (the old owner-only claim file) is rebuilt from the answer it
 *     belongs to, and the question is marked delivered only when the files say it was.
 *
 * Files are found by name in each directory given, in its `conf/` and in its `cache/`, so a single directory holding
 * everything, one directory per kind, and a whole install copied side by side all work.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { appendHeld, HELD, heldId, type Held } from "./afk.ts";
import { NOTIFICATION_LOG } from "./notification.ts";
import { parseRightsSent, RIGHTS_SENT_KEY } from "./rights-sent.ts";
import { askQuestion, claimWake, finishRelay, notNow, pageClaim, startRelay, type Answer, type Claim, type Question } from "./questions.ts";
import { type Ruling } from "./rulings.ts";
import { checkVersion } from "./schema.ts";
import type { DecisionRow, Store } from "./store.ts";
import { HEALTH_KEY, type Health } from "./steward-health.ts";
import { QUEUE } from "./questions.ts";

const ITEM_ID = /^Q-[a-z0-9]{4,16}$/;
/** A delivery is kept on record 30 days; an older one would be pruned at the first maintenance, so it is not worth importing. */
const DELIVERED_KEEP_MS = 30 * 24 * 3600_000;
const SWEEP_CLOCK = "sweep-clock";

export type ImportCount = { read: number; imported: number; present: number };
export type ImportReport = {
	/** The directories read. */
	from: string[];
	/** The files and folders recognised, by name, and where. */
	found: Record<string, string>;
	counts: Record<string, ImportCount>;
	/** Records not imported, with the reason. */
	skipped: { what: string; why: string }[];
	/** Torn or unreadable lines, by file. */
	tornLines: Record<string, number>;
	/** Files in the directories that are not state and were left alone. */
	ignored: string[];
	notes: string[];
};

type Raw = Record<string, unknown>;

/** Every place a name may be: the directory itself, its conf/ and its cache/. */
function locate(dirs: string[], name: string): string | undefined {
	for (const d of dirs) for (const sub of ["", "conf", "cache"]) { const p = sub ? `${d}/${sub}/${name}` : `${d}/${name}`; if (existsSync(p)) return p; }
	return undefined;
}

class Reader {
	readonly torn: Record<string, number> = {};
	constructor(readonly dirs: string[]) {}
	text(name: string): string | undefined { const p = locate(this.dirs, name); return p ? readFileSync(p, "utf8") : undefined; }
	path(name: string) { return locate(this.dirs, name); }
	/** A JSONL file's lines with their records, oldest first. A record from a newer build throws (SchemaTooNewError); a torn line is counted. */
	lines(name: string): { line: string; rec: Raw }[] {
		const t = this.text(name);
		if (t === undefined) return [];
		const out: { line: string; rec: Raw }[] = [];
		for (const l of t.split("\n")) {
			if (!l.trim()) continue;
			let rec: unknown;
			try { rec = JSON.parse(l); } catch { this.torn[name] = (this.torn[name] ?? 0) + 1; continue; }
			if (!rec || typeof rec !== "object" || Array.isArray(rec)) { this.torn[name] = (this.torn[name] ?? 0) + 1; continue; }
			checkVersion(name, (rec as Raw).schemaVersion);
			out.push({ line: l, rec: rec as Raw });
		}
		return out;
	}
	/** A JSONL file's records, oldest first (see `lines`). */
	jsonl(name: string): Raw[] { return this.lines(name).map((x) => x.rec); }
	/**
	 * A JSON document, or undefined when missing or unreadable (counted). A newer schemaVersion throws, in the document itself, in each
	 * object of a list, and in each object of an `items` list. (A file with no schemaVersion is unversioned and passes.)
	 */
	json<T = unknown>(name: string): T | undefined {
		const t = this.text(name);
		if (t === undefined) return undefined;
		let v: unknown;
		try { v = JSON.parse(t); } catch { this.torn[name] = (this.torn[name] ?? 0) + 1; return undefined; }
		checkRecords(name, v);
		return v as T;
	}
	/** The files directly inside a folder (woken/, relayed/, evidence/), by name. */
	folder(name: string): { name: string; path: string }[] {
		const p = locate(this.dirs, name);
		if (!p || !statSync(p).isDirectory()) return [];
		return readdirSync(p).sort().map((n) => ({ name: n, path: `${p}/${n}` }));
	}
}

/** Throws SchemaTooNewError for a newer record: the document itself, each object of a list, each object of an `items` list. */
function checkRecords(name: string, v: unknown) {
	const objects = (x: unknown): Raw[] => (Array.isArray(x) ? x.filter((y): y is Raw => Boolean(y) && typeof y === "object" && !Array.isArray(y)) : []);
	if (Array.isArray(v)) { for (const o of objects(v)) checkVersion(name, o.schemaVersion); return; }
	if (v && typeof v === "object") { checkVersion(name, (v as Raw).schemaVersion); for (const o of objects((v as Raw).items)) checkVersion(`${name} (item)`, o.schemaVersion); }
}

const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const iso = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? v : undefined);

// ---- the old queue, folded the way the old code folded it -----------------------------------------

type OldState = { q: Question; answer?: Answer; delivered: boolean; onCard: boolean; notNowAt?: string; relayed?: { outcome: "delivered" | "failed"; t: string; detail?: string } };
function foldQueue(events: Raw[]): Map<string, OldState> {
	const out = new Map<string, OldState>();
	for (const e of events) {
		if (e.type === "ask") {
			const q = e.item as Question | undefined;
			if (q && typeof q.id === "string" && ITEM_ID.test(q.id) && !out.has(q.id)) out.set(q.id, { q, delivered: false, onCard: false });
			continue;
		}
		const s = out.get(String(e.id));
		if (!s) continue;
		if (e.type === "answer" && !s.answer && !s.onCard) s.answer = e.answer as Answer;
		else if (e.type === "answered-on-card" && !s.answer) s.onCard = true;
		else if (e.type === "delivered" && s.answer?.deliveryId === e.deliveryId) s.delivered = true;
		else if (e.type === "not-now") s.notNowAt = str(e.t);
		else if (e.type === "relayed" && (e.outcome === "delivered" || e.outcome === "failed")) s.relayed = { outcome: e.outcome, t: str(e.t) ?? "", ...(str(e.detail) ? { detail: str(e.detail) } : {}) };
	}
	return out;
}

/** A claim file in either shape, or undefined for the old owner-only text (which carries no wake). */
function parseClaimFile(item: string, text: string): Claim | undefined {
	try {
		const c = JSON.parse(text) as Raw & { v?: number };
		if (c && typeof c === "object") {
			if (c.schemaVersion !== undefined) checkVersion(`woken/${item}`, c.schemaVersion);
			if ((c.schemaVersion !== undefined || c.v === 2) && typeof c.owner === "string" && typeof c.deliveryId === "string" && typeof c.message === "string" && c.item === item) {
				const { schemaVersion: _s, v: _v, ...rest } = c;
				return { ...rest, t: iso(c.t) ?? new Date(0).toISOString() } as unknown as Claim;
			}
		}
	} catch (e) { if (e instanceof Error && e.name === "SchemaTooNewError") throw e; /* not JSON: the old owner-only claim */ }
	return undefined;
}

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const count = (report: ImportReport, what: string): ImportCount => (report.counts[what] ??= { read: 0, imported: 0, present: 0 });
const tally = (report: ImportReport, what: string, fresh: boolean) => { const c = count(report, what); c.read++; if (fresh) c.imported++; else c.present++; };

const STATE_FILES = ["queue.jsonl", "rulings.jsonl", "butlers.jsonl", "afk.json", "decisions.jsonl", "held.jsonl", "held-closed.jsonl", "held-wakes.json", "held-wakes.landed.jsonl", "pending-wakes.json", "pending-wakes.queue-web.json", "pending-wakes.landed.jsonl", "pending-wakes.queue-web.landed.jsonl", "events.jsonl", "fired.json", "sweep-state.json", "rights-sent.json", "steward-health.json", "heartbeat.json"];
const STATE_DIRS = ["woken", "relayed", "evidence", "afk-archive"];
/** Config the importer leaves to the operator: nothing in it is state. */
const CONFIG_FILES = new Set(["servers.json", "settings.json", "web.json", "sweep.json", "decision-rights.md", "operating-rules.json", "operating-rules.md", "steward-thread", "decisions-thread", "wake-url", "compact-url", "read-token", "sweep-prompt.md", "daemon.env", "steward-brief.md"]);

export type ImportOptions = { now?: number; dryRun?: boolean };

/**
 * Imports everything the directories hold into the store. With `dryRun` nothing is written: the report says what would be.
 * Throws SchemaTooNewError, before writing anything, for a record from a newer Chamberlain.
 */
export function importLegacy(store: Store, dirs: string[], o: ImportOptions = {}): ImportReport {
	const now = o.now ?? Date.now();
	const r = new Reader(dirs);
	const report: ImportReport = { from: dirs, found: {}, counts: {}, skipped: [], tornLines: r.torn, ignored: [], notes: [] };
	for (const n of [...STATE_FILES, ...STATE_DIRS]) { const p = r.path(n); if (p) report.found[n] = p; }
	const ignored = new Set<string>();
	for (const d of dirs) for (const sub of ["", "conf", "cache"]) {
		const dir = sub ? `${d}/${sub}` : d;
		if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
		for (const n of readdirSync(dir).sort()) if (!STATE_FILES.includes(n) && !STATE_DIRS.includes(n) && !CONFIG_FILES.has(n) && !["conf", "cache"].includes(n) && !/\.(tmp|lock)/.test(n)) ignored.add(sub ? `${sub}/${n}` : n);
	}
	report.ignored.push(...ignored);

	// ---- read everything first: a newer record stops the import before any write ----
	const queue = foldQueue(r.jsonl("queue.jsonl"));
	const claimFiles = new Map<string, Claim | "legacy">();
	for (const f of r.folder("woken")) if (ITEM_ID.test(f.name)) claimFiles.set(f.name, parseClaimFile(f.name, readFileSync(f.path, "utf8")) ?? "legacy");
	/** A JSON object in a file, or undefined when the file is missing or unreadable. A newer schemaVersion throws. */
	const readRecord = (path: string, what: string): Raw | undefined => {
		let rec: unknown;
		try { rec = JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
		if (!rec || typeof rec !== "object" || Array.isArray(rec)) return undefined;
		checkVersion(what, (rec as Raw).schemaVersion);
		return rec as Raw;
	};
	const relayFiles = new Map<string, { started: string; outcome?: "delivered" | "failed"; detail?: string; finished?: string }>();
	for (const f of r.folder("relayed")) {
		if (f.name.endsWith(".result") || !ITEM_ID.test(f.name)) continue;
		// The start record and its result are records of their own, so each is version-checked here, before anything is written.
		const start = readRecord(f.path, `relayed/${f.name}`);
		const startedAt = iso(start?.t) ?? new Date(statSync(f.path).mtimeMs).toISOString();
		const res = readRecord(`${f.path}.result`, `relayed/${f.name}.result`); // absent: started, never finished
		relayFiles.set(f.name, { started: startedAt, ...(res && (res.outcome === "delivered" || res.outcome === "failed") ? { outcome: res.outcome } : {}), ...(res && str(res.detail) ? { detail: str(res.detail) } : {}), ...(res && iso(res.t) ? { finished: iso(res.t) } : {}) });
	}
	const rulings = r.jsonl("rulings.jsonl") as unknown as Ruling[];
	const butlerLines = r.jsonl("butlers.jsonl");
	const decisions = r.jsonl("decisions.jsonl") as unknown as (DecisionRow & Raw)[];
	const heldLines = r.jsonl("held.jsonl") as unknown as Held[];
	const closures = r.jsonl("held-closed.jsonl") as unknown as { t: string; id: string; how: string }[];
	const heldWakes = r.json<{ items?: { deliveryId: string; message: string; queuedAt: number; kind?: string; thread?: string }[] }>("held-wakes.json");
	const pendingDaemon = r.json<{ deliveryId: string; message: string; queuedAt: number; kind?: string; thread?: string }[]>("pending-wakes.json");
	const pendingPage = r.json<{ deliveryId: string; message: string; queuedAt: number; kind?: string; thread?: string }[]>("pending-wakes.queue-web.json");
	const delivered = new Map<string, number>();
	for (const f of ["held-wakes.landed.jsonl", "pending-wakes.landed.jsonl", "pending-wakes.queue-web.landed.jsonl"]) {
		// A landing record is a record like any other: version-checked with the rest (r.lines), before anything is written.
		for (const { rec: x } of r.lines(f)) if (typeof x.deliveryId === "string" && typeof x.t === "number" && now - x.t <= DELIVERED_KEEP_MS) delivered.set(x.deliveryId, x.t);
	}
	const fired = r.json<string[]>("fired.json");
	const sweepState = r.json<Raw>("sweep-state.json");
	const rightsSent = r.json<unknown>("rights-sent.json");
	const health = r.json<Health>("steward-health.json");
	const heartbeat = r.json<unknown>("heartbeat.json");
	const afk = r.json<Raw>("afk.json");
	// The event log is read, and version-checked, with everything else: before the transaction opens.
	const events = r.lines("events.jsonl");
	if (o.dryRun) return dryRun(report, { queue, claimFiles, relayFiles, rulings, butlerLines, decisions, heldLines, closures, delivered, fired, events: events.length, store });

	// ---- write it all in one transaction, the event log included ----
	store.tx(() => {
		importEvents(store, events, report);
		// Landings first: a wake on a delivered ledger is never made pending or held again.
		for (const [id, t] of delivered) {
			// A delivered row with no text: the old ledger kept only the id, and the row is what stops it being sent again.
			const fresh = !store.wakes.find(id);
			if (fresh) store.wakes.enqueue({ deliveryId: id, message: "", queuedAt: t });
			const row = store.wakes.find(id);
			if (row?.status === "pending") store.wakes.finish(row.id, "delivered", t);
			tally(report, "delivered wakes", fresh);
		}

		// The queue, with each question's answer flow.
		const existing = new Set(store.items.list({ source: QUEUE }).map((i) => i.dedupKey));
		for (const [id, s] of queue) {
			const fresh = !existing.has(id);
			const { evidence: _e, ...rest } = s.q;
			askQuestion(store, { ...s.q, ...(rest.createdAt ? {} : { createdAt: new Date(now).toISOString() }) }, Date.parse(s.q.createdAt) || now);
			tally(report, "questions", fresh);
			if (!fresh) continue;
			const fileClaim = claimFiles.get(id);
			const answer = s.answer ?? (fileClaim && fileClaim !== "legacy" ? fileClaim.answer : undefined);
			if (s.onCard && !answer) {
				store.items.resolve(QUEUE, id, now, { answeredOnCard: true });
			} else if (answer) {
				// The claim is the wake. A claim file carries it; the old owner-only file and a claim lost to a crash do not, so it is rebuilt from the answer.
				const claim: Claim = fileClaim && fileClaim !== "legacy" ? fileClaim : pageClaim(s.q, answer);
				if (fileClaim === "legacy") report.notes.push(`${id}: an old-format claim file carried no wake; its wake was rebuilt from the recorded answer`);
				claimWake(store, { ...claim, answer: claim.answer ?? answer });
				const direct = relayFiles.get(id)?.outcome === "delivered" || s.relayed?.outcome === "delivered";
				if (s.delivered || delivered.has(claim.deliveryId) || direct) store.items.resolve(QUEUE, id, now);
			} else if (s.notNowAt) {
				notNow(store, id, s.notNowAt);
			}
			const rf = relayFiles.get(id);
			if (rf) { startRelay(store, id); if (rf.outcome) store.claims.finishRelay(QUEUE, id, rf.outcome, rf.detail, rf.finished); }
			else if (s.relayed) { startRelay(store, id); finishRelay(store, id, s.relayed.outcome, s.relayed.detail); }
		}
		for (const [id, c] of claimFiles) if (!queue.has(id)) report.skipped.push({ what: `woken/${id}`, why: c === "legacy" ? "an old-format claim with no question in queue.jsonl" : "a claim with no question in queue.jsonl" });

		// Rulings, by id. An id already in the database is left as it is.
		const have = new Map(store.rulings.list().map((x) => [x.id, x]));
		for (const x of rulings) {
			if (typeof x.id !== "string" || !/^R\d+$/.test(x.id)) { report.skipped.push({ what: "rulings.jsonl", why: `a record without a ruling id (${String(x.id).slice(0, 20)})` }); continue; }
			const fresh = !have.has(x.id);
			if (fresh) { const { schemaVersion: _s, ...clean } = x as Ruling & Raw; store.rulings.save({ ...clean, history: clean.history ?? [] } as Ruling); have.set(x.id, x); }
			else if (JSON.stringify(strip(have.get(x.id)!)) !== JSON.stringify(strip(x))) report.skipped.push({ what: `ruling ${x.id}`, why: "already in the database with different content: the database's copy was kept" });
			tally(report, "rulings", fresh);
		}

		// Butlers: a start line, then its stop line.
		for (const l of butlerLines) {
			if (typeof l.id !== "string") { report.skipped.push({ what: "butlers.jsonl", why: "a line without an id" }); continue; }
			if (typeof l.thread === "string" && typeof l.started === "string") {
				const fresh = store.butlers.insert({ id: l.id, thread: l.thread, machine: String(l.machine ?? ""), model: String(l.model ?? ""), scope: String(l.scope ?? ""), started: l.started });
				tally(report, "butlers", fresh);
			} else if (typeof l.stopped === "string") store.butlers.stop(l.id, l.stopped, str(l.reason));
		}

		// Decisions: no natural key, so a decision identical in every field to one already there is the same decision.
		const seenDecisions = new Set(store.decisions.list().map((d) => sha(JSON.stringify([d.t, d.thread, d.decision, d.ruling, d.ref]))));
		for (const d of decisions) {
			if (typeof d.t !== "string" || typeof d.thread !== "string" || typeof d.decision !== "string") { report.skipped.push({ what: "decisions.jsonl", why: "a line without t, thread and decision" }); continue; }
			const row: DecisionRow = { t: d.t, thread: d.thread, decision: d.decision, ruling: String(d.ruling ?? ""), ...(Array.isArray(d.rulingIds) ? { rulingIds: d.rulingIds as string[] } : {}), ref: (d.ref as string | null | undefined) ?? null };
			const key = sha(JSON.stringify([row.t, row.thread, row.decision, row.ruling, row.ref]));
			const fresh = !seenDecisions.has(key);
			if (fresh) { store.decisions.append(row); seenDecisions.add(key); }
			tally(report, "decisions", fresh);
		}

		// Held for the operator's return: each hold an item of source held, closed by its closure line.
		for (const h of heldLines) {
			if (!iso(h.t) || typeof h.thread !== "string" || typeof h.what !== "string") { report.skipped.push({ what: "held.jsonl", why: "a line without t, thread and what" }); continue; }
			const { t: _t, schemaVersion: _s, ...rest } = h as Held & Raw;
			const fresh = !store.items.get(HELD, heldId(h));
			appendHeld(store, rest as Omit<Held, "t">, new Date(h.t));
			tally(report, "held for return", fresh);
		}
		for (const c of closures) if (typeof c.id === "string") store.items.resolve(HELD, c.id, Date.parse(c.t) || now, { closedAt: c.t, how: c.how });

		// Wakes still pending or held, unless they delivered.
		for (const [owner, list] of [["daemon", pendingDaemon], ["queue-web", pendingPage]] as const) {
			for (const w of Array.isArray(list) ? list : []) {
				if (typeof w.deliveryId !== "string" || typeof w.message !== "string") { report.skipped.push({ what: `pending wakes (${owner})`, why: "a wake without an id and a message" }); continue; }
				if (delivered.has(w.deliveryId) || store.wakes.isDelivered(w.deliveryId)) { report.skipped.push({ what: `pending wake ${w.deliveryId}`, why: "already delivered: never sent again" }); continue; }
				tally(report, "pending wakes", store.wakes.enqueue({ deliveryId: w.deliveryId, message: w.message, queuedAt: Number(w.queuedAt) || now, ...(w.kind ? { kind: w.kind } : {}), ...(w.thread ? { thread: w.thread } : {}) }));
			}
		}
		for (const w of heldWakes?.items ?? []) {
			if (typeof w.deliveryId !== "string" || typeof w.message !== "string") continue;
			if (delivered.has(w.deliveryId) || store.wakes.isDelivered(w.deliveryId)) { report.skipped.push({ what: `held wake ${w.deliveryId}`, why: "already delivered: never sent again" }); continue; }
			const fresh = store.wakes.hold({ deliveryId: w.deliveryId, message: w.message, queuedAt: Number(w.queuedAt) || now, ...(w.kind ? { kind: w.kind } : {}), ...(w.thread ? { thread: w.thread } : {}) });
			tally(report, "held wakes", fresh);
		}
		if (heldWakes?.items?.length === undefined && report.found["held-wakes.json"]) report.notes.push("held-wakes.json held no items");

		// What already went out: one notification-log item per dedup key, so none goes again.
		for (const key of Array.isArray(fired) ? fired : []) {
			if (typeof key !== "string") continue;
			// An item that is already there is left exactly as it is (observing it would refresh last_seen).
			const fresh = !store.items.get(NOTIFICATION_LOG, key);
			if (fresh) store.items.observe({ source: NOTIFICATION_LOG, kind: "sent", dedupKey: key, now });
			tally(report, "fired keys", fresh);
		}

		// The sweep clock, and the findings it had already seen, now acknowledged items of their check.
		if (sweepState) {
			const prior = store.state.get(SWEEP_CLOCK);
			const t = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : now);
			// A record from the away-only days stopped when the principal came back: its gap is not news, so it starts from now.
			if (!prior) store.state.set(SWEEP_CLOCK, { lastAt: "away" in sweepState ? now : t(sweepState.lastAt), lastFullAt: t(sweepState.lastFullAt), seeded: sweepState.seeded === true });
			tally(report, "sweep clock", !prior);
			for (const k of Array.isArray(sweepState.seen) ? (sweepState.seen as unknown[]) : []) {
				const [name, ...rest] = String(k).split(":");
				if (!name || !rest.length) { report.skipped.push({ what: "sweep-state.json", why: `a seen key with no check name (${String(k).slice(0, 40)})` }); continue; }
				const fresh = !store.items.get(`check:${name}`, rest.join(":"));
				if (fresh) store.items.observe({ source: `check:${name}`, kind: "finding", dedupKey: rest.join(":"), baseline: true, now });
				tally(report, "seen findings", fresh);
			}
		}
		if (rightsSent !== undefined) { const ok = parseRightsSent(rightsSent); if (ok) { const fresh = store.state.get(RIGHTS_SENT_KEY) === undefined; if (fresh) store.state.set(RIGHTS_SENT_KEY, ok); tally(report, "rights sent", fresh); } else report.skipped.push({ what: "rights-sent.json", why: "not a record the next wake can trust: it will send the rights in full" }); }
		if (health && typeof health === "object") { const fresh = store.state.get(HEALTH_KEY) === undefined; if (fresh) { const { schemaVersion: _s, ...h } = health as Health & Raw; store.state.set(HEALTH_KEY, h); } tally(report, "steward health", fresh); }
		if (heartbeat && typeof heartbeat === "object") { const fresh = store.state.get("heartbeat") === undefined; if (fresh) store.state.set("heartbeat", heartbeat); tally(report, "heartbeat", fresh); }

		// The away record. Past absences (afk-archive/) are history only and stay where they are.
		if (afk && typeof afk.enteredAt === "string" && typeof afk.words === "string") {
			const cur = store.away.current();
			const fresh = !cur;
			if (fresh) store.away.enter({ enteredAt: afk.enteredAt, words: afk.words, ...(str(afk.expectedReturn) ? { expectedReturn: str(afk.expectedReturn) } : {}), ...(str(afk.spendNote) ? { spendNote: str(afk.spendNote) } : {}) });
			else if (cur.enteredAt !== afk.enteredAt) report.skipped.push({ what: "afk.json", why: "the database already has a different current absence: it was kept" });
			tally(report, "away record", fresh);
		}
		if (r.folder("afk-archive").length) report.notes.push(`afk-archive/ holds ${r.folder("afk-archive").length} past absence record(s): history only, left in place`);
	});

	for (const ev of r.folder("evidence")) report.notes.push(`evidence/${ev.name} stays on disk where it is; the questions' evidence rows point to it by file name (copy the folder to <state directory>/evidence/ if the database lives elsewhere)`);
	return report;
}

const strip = (x: Ruling & Raw) => { const { schemaVersion: _s, ...rest } = x; return { ...rest, history: rest.history ?? [] }; };

/** The event log, inside the import's one transaction: each row under a hash of its own line, so a rerun adds nothing. */
function importEvents(store: Store, events: { line: string; rec: Raw }[], report: ImportReport) {
	if (!events.length && !report.found["events.jsonl"]) return;
	const c = count(report, "events");
	for (const { line, rec: e } of events) {
		if (typeof e.t !== "string" || typeof e.event !== "string") { report.tornLines["events.jsonl"] = (report.tornLines["events.jsonl"] ?? 0) + 1; continue; }
		c.read++;
		const before = store.events.count();
		store.events.append(e as never, `import:${sha(line)}`);
		if (store.events.count() > before) c.imported++; else c.present++;
	}
}

function dryRun(report: ImportReport, x: { queue: Map<string, OldState>; claimFiles: Map<string, unknown>; relayFiles: Map<string, unknown>; rulings: Ruling[]; butlerLines: Raw[]; decisions: Raw[]; heldLines: Held[]; closures: unknown[]; delivered: Map<string, number>; fired: string[] | undefined; events: number; store: Store }): ImportReport {
	const set = (what: string, read: number, present: number) => { report.counts[what] = { read, imported: 0, present }; };
	const have = new Set(x.store.items.list({ source: QUEUE }).map((i) => i.dedupKey));
	set("questions", x.queue.size, [...x.queue.keys()].filter((k) => have.has(k)).length);
	set("claim files", x.claimFiles.size, 0);
	set("direct sends", x.relayFiles.size, 0);
	const rs = new Set(x.store.rulings.list().map((r) => r.id));
	set("rulings", x.rulings.length, x.rulings.filter((r) => rs.has(r.id)).length);
	set("butlers", x.butlerLines.filter((l) => typeof l.thread === "string").length, 0);
	set("decisions", x.decisions.length, 0);
	set("held for return", x.heldLines.length, 0);
	set("delivered wakes", x.delivered.size, 0);
	set("fired keys", Array.isArray(x.fired) ? x.fired.length : 0, 0);
	set("events", x.events, 0);
	report.notes.push("dry run: nothing was written; 'imported' is 0 and 'present' counts only what could be matched without importing");
	return report;
}

/** Human text for a report. */
export function formatReport(r: ImportReport): string {
	const lines = [`Read from: ${r.from.join(", ")}`, ""];
	for (const [what, c] of Object.entries(r.counts)) lines.push(`${what.padEnd(18)} read ${String(c.read).padStart(6)}  imported ${String(c.imported).padStart(6)}  already there ${String(c.present).padStart(6)}`);
	if (!Object.keys(r.counts).length) lines.push("Nothing to import was found.");
	for (const [f, n] of Object.entries(r.tornLines)) lines.push(`${f}: ${n} torn or unreadable line${n === 1 ? "" : "s"} skipped`);
	if (r.skipped.length) lines.push("", "Skipped:", ...r.skipped.map((s) => `  ${s.what}: ${s.why}`));
	if (r.notes.length) lines.push("", "Notes:", ...r.notes.map((n) => `  ${n}`));
	if (r.ignored.length) lines.push("", `Left alone (not state): ${r.ignored.join(", ")}`);
	lines.push("", "No source file was changed or deleted.");
	return lines.join("\n");
}
