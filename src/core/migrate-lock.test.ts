/**
 * The config migration's exclusion is the kernel's, never a clock's. A reviewer found the old one, a lock file that any other process
 * broke after 120 seconds: a migration slower than that could be entered twice, and its owner could unlink its successor's lock. These
 * tests run real processes (src/testing/migrate-worker.ts) with a slow migration injected, and read a journal of who was inside and when.
 * To make the old age-based lock break at once, every lock artefact it could have left is back-dated by ten minutes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { SCHEMA_VERSION } from "./schema.ts";
import { holdFlock } from "./singleton.ts";
import { migrateStorage, type MigrationReport } from "./migrate.ts";

const WORKER = new URL("../testing/migrate-worker.ts", import.meta.url).pathname;
const dirs: string[] = [];
const pids: number[] = [];
afterEach(() => {
	for (const pid of pids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world() {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-migrate-lock-`);
	dirs.push(root);
	const conf = `${root}/conf`, state = `${root}/state`, journal = `${root}/journal`;
	mkdirSync(conf, { mode: 0o700 }); mkdirSync(state, { mode: 0o700 });
	const put = (name: string, body: string) => { writeFileSync(`${conf}/${name}`, body, { mode: 0o600 }); chmodSync(`${conf}/${name}`, 0o600); };
	put("servers.json", JSON.stringify([{ name: "main", origin: "http://127.0.0.1:3773", tokenFile: "read-token" }]));
	put("web.json", JSON.stringify({ host: "127.0.0.1", port: 3790 }));
	put("settings.json", JSON.stringify({ principalName: "Ada" }));
	put("sweep.json", JSON.stringify({ checks: [] }));
	writeFileSync(journal, "");
	return { root, conf, state, journal };
}
type W = ReturnType<typeof world>;

/** A migrating process that holds the lock `holdMs` and waits `waitMs` for it. `done` resolves with its report. */
function worker(w: W, holdMs: number, waitMs: number) {
	const p = Bun.spawn([process.execPath, WORKER, w.conf, w.state, w.journal, String(holdMs), String(waitMs)], { stdout: "pipe", stderr: "pipe" });
	pids.push(p.pid);
	return { p, pid: p.pid, done: (async () => { const out = await new Response(p.stdout).text(); const err = await new Response(p.stderr).text(); await p.exited; return { report: JSON.parse(out.trim().split("\n").pop() || "null") as MigrationReport | null, err, code: p.exitCode }; })() };
}
const events = (w: W) => readFileSync(w.journal, "utf8").split("\n").filter(Boolean).map((l) => { const [pid, what, t] = l.split(" "); return { pid: Number(pid), what: what!, t: Number(t) }; });
async function until(what: string, ok: () => boolean, ms = 8000) {
	const end = Date.now() + ms;
	while (!ok()) { if (Date.now() > end) throw Error(`timed out waiting for ${what}`); await Bun.sleep(10); }
}
/** Back-dates anything an age-based lock could be keyed on. */
function age(w: W) {
	const old = new Date(Date.now() - 600_000);
	for (const p of [`${w.state}/.migrate.lock`, `${w.conf}/.migrate.lock`, w.conf, w.state]) if (existsSync(p)) utimesSync(p, old, old);
}
const versions = (w: W) => ["servers.json", "web.json", "settings.json", "sweep.json"].map((f) => JSON.parse(readFileSync(`${w.conf}/${f}`, "utf8")).schemaVersion);

describe("the config migration lock belongs to the kernel", () => {
	test("a slow migration is never entered twice: back-dated lock artefacts do not let a second or a third migrator in, and the first finishes the work", async () => {
		const w = world();
		const first = worker(w, 4000, 5000);
		await until("the first migrator to hold the lock", () => events(w).some((e) => e.what === "enter"));
		age(w);
		const second = await worker(w, 300, 300).done;
		age(w);
		const third = await worker(w, 300, 300).done;
		// Neither was let in while the first was inside: each skipped, changed nothing, and said who it was waiting for.
		for (const r of [second, third]) {
			expect(r.err).toBe("");
			expect(r.report!.migrated).toEqual([]);
			expect(r.report!.skipped).toHaveLength(1);
			expect(r.report!.skipped[0]!.why).toContain("another process is migrating");
		}
		expect(events(w).filter((e) => e.what === "enter")).toHaveLength(1);
		expect(versions(w)).toEqual([undefined, undefined, undefined, undefined]); // the first has not rewritten anything yet
		const done = await first.done;
		expect(done.report!.migrated.sort()).toEqual(["servers.json", "settings.json", "sweep.json", "web.json"]);
		expect(versions(w)).toEqual([SCHEMA_VERSION, SCHEMA_VERSION, SCHEMA_VERSION, SCHEMA_VERSION]);
		// Exactly one process was ever inside, and nobody left a lock behind to be broken.
		expect(events(w).map((e) => `${e.pid === first.pid ? "first" : "other"} ${e.what}`)).toEqual(["first enter", "first exit"]);
		expect(readdirSync(w.conf).filter((f) => f.includes("lock"))).toEqual([]);
		expect(readdirSync(w.state).filter((f) => f.includes("lock"))).toEqual([]);
	});

	test("a second migrator waits for the first and goes in only after it has left; it finds the work done", async () => {
		const w = world();
		const first = worker(w, 1200, 5000);
		await until("the first migrator to hold the lock", () => events(w).some((e) => e.what === "enter"));
		const second = worker(w, 100, 10_000);
		const [a, b] = [await first.done, await second.done];
		expect(a.report!.migrated).toHaveLength(4);
		expect(b.report).toEqual({ migrated: [], skipped: [] });
		const ev = events(w);
		expect(ev.map((e) => `${e.pid === first.pid ? "first" : "second"} ${e.what}`)).toEqual(["first enter", "first exit", "second enter", "second exit"]);
		expect(ev[2]!.t).toBeGreaterThanOrEqual(ev[1]!.t);
		expect(versions(w)).toEqual([SCHEMA_VERSION, SCHEMA_VERSION, SCHEMA_VERSION, SCHEMA_VERSION]);
	});

	test("a holder that is killed releases the lock at once: the next migrator does not wait out any age and does the work", async () => {
		const w = world();
		const first = worker(w, 60_000, 5000);
		await until("the first migrator to hold the lock", () => events(w).some((e) => e.what === "enter"));
		first.p.kill("SIGKILL");
		await first.p.exited;
		const t0 = Date.now();
		const second = await worker(w, 0, 5000).done;
		expect(second.report!.migrated).toHaveLength(4);
		expect(second.report!.skipped).toEqual([]);
		expect(Date.now() - t0).toBeLessThan(4000);
		expect(versions(w)).toEqual([SCHEMA_VERSION, SCHEMA_VERSION, SCHEMA_VERSION, SCHEMA_VERSION]);
	});

	test("in one process: a held lock makes the migration skip after its wait, with the reason; once released it migrates", () => {
		const w = world();
		const lock = holdFlock(w.conf, { waitMs: 0 });
		const started = Date.now();
		const r = migrateStorage({ conf: w.conf, state: w.state, lockWaitMs: 150 });
		expect(Date.now() - started).toBeGreaterThanOrEqual(140);
		expect(r.migrated).toEqual([]);
		expect(r.skipped[0]!.why).toMatch(/^another process is migrating .* nothing was changed/);
		expect(versions(w)).toEqual([undefined, undefined, undefined, undefined]);
		lock.release();
		expect(migrateStorage({ conf: w.conf, state: w.state, lockWaitMs: 150 }).migrated).toHaveLength(4);
	});

	test("holdFlock refuses a second holder, never breaks a lock by age, and a release by one holder never frees another's", () => {
		const w = world();
		const a = holdFlock(w.conf, { waitMs: 0 });
		age(w);
		expect(() => holdFlock(w.conf, { waitMs: 50 })).toThrow(/locked by another process/);
		a.release();
		a.release(); // a second release is a no-op
		const b = holdFlock(w.conf, { waitMs: 0 });
		expect(() => holdFlock(w.conf, { waitMs: 20 })).toThrow(/locked/);
		a.release(); // the old holder releasing again must not free b's lock
		expect(() => holdFlock(w.conf, { waitMs: 20 })).toThrow(/locked/);
		b.release();
		holdFlock(w.conf, { waitMs: 0 }).release();
	});
});
