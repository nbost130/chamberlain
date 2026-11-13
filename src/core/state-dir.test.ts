import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { defaultStore } from "./default-store.ts";
import { openStore } from "./sqlite-store.ts";
import { configDir, legacyCacheDirs, moveStateOutOfCache, stateDir } from "./state-dir.ts";
import { holdFlock } from "./singleton.ts";
import { DB_FILE, dbPath } from "./store.ts";

const scratch = () => mkdtempSync(`${tmpdir()}/chamberlain-state-`);
const HOME = "/home/u";

describe("where the directories are (XDG Base Directory Specification)", () => {
	test("state: CHAMBERLAIN_STATE, then XDG_STATE_HOME, then ~/.local/state", () => {
		expect(stateDir({}, HOME)).toBe("/home/u/.local/state/chamberlain");
		expect(stateDir({ XDG_STATE_HOME: "/var/xdg" }, HOME)).toBe("/var/xdg/chamberlain");
		expect(stateDir({ XDG_STATE_HOME: "/var/xdg/" }, HOME)).toBe("/var/xdg/chamberlain");
		expect(stateDir({ XDG_STATE_HOME: "/var/xdg", CHAMBERLAIN_STATE: "/srv/chamberlain-state" }, HOME)).toBe("/srv/chamberlain-state");
	});
	test("an empty or relative value is invalid and ignored, as the specification says", () => {
		expect(stateDir({ XDG_STATE_HOME: "" }, HOME)).toBe("/home/u/.local/state/chamberlain");
		expect(stateDir({ XDG_STATE_HOME: "relative/dir" }, HOME)).toBe("/home/u/.local/state/chamberlain");
		expect(stateDir({ CHAMBERLAIN_STATE: "relative" }, HOME)).toBe("/home/u/.local/state/chamberlain");
		expect(stateDir({ CHAMBERLAIN_STATE: "" }, HOME)).toBe("/home/u/.local/state/chamberlain");
	});
	test("config follows the same rule", () => {
		expect(configDir({}, HOME)).toBe("/home/u/.config/chamberlain");
		expect(configDir({ XDG_CONFIG_HOME: "/etc/xdg" }, HOME)).toBe("/etc/xdg/chamberlain");
		expect(configDir({ CHAMBERLAIN_CONF: "/x" }, HOME)).toBe("/x");
	});
	test("the old cache locations, in the order an earlier build would have used them", () => {
		expect(legacyCacheDirs({}, HOME)).toEqual(["/home/u/.cache/chamberlain"]);
		expect(legacyCacheDirs({ CHAMBERLAIN_CACHE: "/c", XDG_CACHE_HOME: "/xc" }, HOME)).toEqual(["/c", "/xc/chamberlain", "/home/u/.cache/chamberlain"]);
		expect(legacyCacheDirs({ CHAMBERLAIN_CACHE: "/home/u/.cache/chamberlain" }, HOME)).toEqual(["/home/u/.cache/chamberlain"]);
	});
});

/** An old install: a database in WAL mode (still open, so its -wal holds unmerged rows), evidence and a hand-off. */
function oldInstall() {
	const root = scratch();
	const old = `${root}/cache`, state = `${root}/state`;
	mkdirSync(`${old}/evidence/Q-aaaa1`, { recursive: true });
	writeFileSync(`${old}/evidence/Q-aaaa1/shot.png`, "png");
	writeFileSync(`${old}/steward-brief.md`, "hand-off");
	const store = openStore(dbPath(old));
	store.rulings.save({ id: "R1", date: "2026-11-01", words: "w", decides: "d", source: "chat", status: "in-force", confirmed: true, history: [] });
	store.events.append({ t: "2026-11-01T00:00:00.000Z", event: "fire" });
	return { root, old, state, store };
}

describe("the one-time move out of the cache directory", () => {
	test("moves the database with its unmerged writes, the evidence and the hand-off, and leaves nothing behind", () => {
		const w = oldInstall();
		expect(existsSync(`${dbPath(w.old)}-wal`)).toBe(true);
		const moved = moveStateOutOfCache(w.state, [w.old]);
		w.store.close();
		expect(moved).toEqual({ from: w.old, to: w.state, moved: ["evidence", "steward-brief.md", DB_FILE] });
		expect(existsSync(dbPath(w.old))).toBe(false);
		expect(existsSync(`${w.old}/evidence`)).toBe(false);
		expect(existsSync(`${w.old}/steward-brief.md`)).toBe(false);
		expect(readFileSync(`${w.state}/steward-brief.md`, "utf8")).toBe("hand-off");
		expect(readFileSync(`${w.state}/evidence/Q-aaaa1/shot.png`, "utf8")).toBe("png");
		const s = openStore(dbPath(w.state));
		expect(s.rulings.list().map((r) => r.id)).toEqual(["R1"]);
		expect(s.events.count()).toBe(1);
		s.close();
		expect(existsSync(`${w.state}/.moving`)).toBe(false);
	});

	test("does it once: a second call finds the database in place and moves nothing", () => {
		const w = oldInstall();
		w.store.close();
		expect(moveStateOutOfCache(w.state, [w.old])).toBeDefined();
		expect(moveStateOutOfCache(w.state, [w.old])).toBeUndefined();
	});

	test("never replaces a database that is already in the state directory", () => {
		const w = oldInstall();
		w.store.close();
		const mine = openStore(dbPath(w.state));
		mine.events.append({ t: "2026-11-02T00:00:00.000Z", event: "mine" });
		mine.close();
		expect(moveStateOutOfCache(w.state, [w.old])).toBeUndefined();
		expect(existsSync(dbPath(w.old))).toBe(true);
		const s = openStore(dbPath(w.state));
		expect(s.events.query().map((e) => e.event)).toEqual(["mine"]);
		s.close();
	});

	test("no old database, nothing to do (and no state directory is made)", () => {
		const root = scratch();
		expect(moveStateOutOfCache(`${root}/state`, [`${root}/nothing`])).toBeUndefined();
		expect(existsSync(`${root}/state`)).toBe(false);
	});

	test("takes the first old location that has a database", () => {
		const w = oldInstall();
		w.store.close();
		const moved = moveStateOutOfCache(w.state, [`${w.root}/empty`, w.old, `${w.root}/other`]);
		expect(moved?.from).toBe(w.old);
	});

	test("a database another process is writing to is refused, not moved, and the old one stays whole", () => {
		const w = oldInstall();
		w.store.close();
		const other = new Database(dbPath(w.old));
		other.exec("BEGIN IMMEDIATE");
		other.exec("INSERT INTO events (t, event, data) VALUES ('2026-11-03T00:00:00.000Z', 'in-flight', '{}')");
		expect(() => moveStateOutOfCache(w.state, [w.old], { busyMs: 50 })).toThrow(/in use by another process/);
		other.exec("ROLLBACK");
		other.close();
		expect(existsSync(dbPath(w.old))).toBe(true);
		expect(existsSync(dbPath(w.state))).toBe(false);
		expect(existsSync(`${w.state}/.moving`)).toBe(false);
		// Once it is quiet, the same call moves it.
		expect(moveStateOutOfCache(w.state, [w.old])).toBeDefined();
	});

	test("another process holding the move lock makes this one wait, and refuse if it is still held when the wait is over", () => {
		const w = oldInstall();
		w.store.close();
		mkdirSync(w.state, { recursive: true });
		const held = holdFlock(w.state, { waitMs: 0 });
		try {
			expect(() => moveStateOutOfCache(w.state, [w.old], { waitMs: 100 })).toThrow(/another Chamberlain process is moving the database/);
		} finally { held.release(); }
		expect(existsSync(dbPath(w.old))).toBe(true);
		// Once the holder lets go, the same call moves it.
		expect(moveStateOutOfCache(w.state, [w.old])).toBeDefined();
	});

	test("a holder that dies (here a SIGKILL) frees the move lock at once: the waiter takes it and moves the database", async () => {
		const w = oldInstall();
		w.store.close();
		mkdirSync(w.state, { recursive: true });
		const singleton = new URL("./singleton.ts", import.meta.url).pathname;
		const holder = Bun.spawn([process.execPath, "-e", `import { holdFlock } from ${JSON.stringify(singleton)}; holdFlock(${JSON.stringify(w.state)}, { waitMs: 0 }); console.log("held"); await Bun.sleep(300); process.kill(process.pid, "SIGKILL");`], { stdout: "pipe", stderr: "pipe" });
		const reader = holder.stdout.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toContain("held");
		const moved = moveStateOutOfCache(w.state, [w.old], { waitMs: 10_000 });
		expect(moved?.moved).toContain(DB_FILE);
		await holder.exited;
		expect(existsSync(dbPath(w.state))).toBe(true);
	});

	test("a leftover .moving file from an earlier build or a crashed mover blocks nothing: the lock is the kernel's, never a file", () => {
		const w = oldInstall();
		w.store.close();
		mkdirSync(w.state, { recursive: true });
		writeFileSync(`${w.state}/.moving`, "999999\n");
		const moved = moveStateOutOfCache(w.state, [w.old], { waitMs: 100 });
		expect(moved?.moved).toContain(DB_FILE);
		expect(existsSync(dbPath(w.state))).toBe(true);
	});

	test("a move that stopped half way (evidence moved, database not) is finished by the next start", () => {
		const w = oldInstall();
		w.store.close();
		mkdirSync(`${w.state}/evidence/Q-aaaa1`, { recursive: true });
		writeFileSync(`${w.state}/evidence/Q-aaaa1/already.png`, "x");
		const moved = moveStateOutOfCache(w.state, [w.old]);
		expect(moved?.moved).toContain(DB_FILE);
		expect(readFileSync(`${w.state}/evidence/Q-aaaa1/shot.png`, "utf8")).toBe("png");
		expect(existsSync(`${w.state}/evidence/Q-aaaa1/already.png`)).toBe(true);
	});
});

describe("defaultStore", () => {
	test("moves the old database, says so on stderr, and records a state-moved event in the database's own log", () => {
		const w = oldInstall();
		w.store.close();
		const lines: string[] = [];
		const real = console.error;
		console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
		let s;
		try { s = defaultStore(w.state, [w.old]); } finally { console.error = real; }
		expect(lines.join("\n")).toContain(`moved the database from ${w.old} to ${w.state}`);
		const ev = s.events.query({ events: ["state-moved"] });
		expect(ev).toHaveLength(1);
		expect(ev[0]).toMatchObject({ from: w.old, to: w.state });
		expect(s.rulings.list()).toHaveLength(1);
		s.close();
	});

	test("an explicit state directory with no old locations given never looks in the home directory", () => {
		const root = scratch();
		const s = defaultStore(`${root}/fresh`, []);
		expect(s.path).toBe(`${root}/fresh/${DB_FILE}`);
		expect(s.events.count({ events: ["state-moved"] })).toBe(0);
		s.close();
	});
});

describe("an entry point, as a real process", () => {
	test("afk.ts status finds an old ~/.cache database, moves it to ~/.local/state, and reads it from there", async () => {
		const home = scratch();
		const old = `${home}/.cache/chamberlain`;
		const store = openStore(dbPath(old));
		store.away.enter({ enteredAt: "2026-11-01T00:00:00.000Z", words: "back on Monday" });
		store.close();
		// The XDG variables are removed, not emptied: Bun's own caches treat an empty XDG_CACHE_HOME as a path relative to the working directory.
		const { XDG_STATE_HOME: _s, XDG_CACHE_HOME: _c, XDG_CONFIG_HOME: _f, CHAMBERLAIN_STATE: _a, CHAMBERLAIN_CACHE: _b, ...rest } = process.env;
		const env = { ...rest, HOME: home, CHAMBERLAIN_CONF: `${home}/.config/chamberlain` };
		const p = Bun.spawn([process.execPath, new URL("./afk.ts", import.meta.url).pathname, "status"], { env, stdout: "pipe", stderr: "pipe" });
		const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
		await p.exited;
		expect(err).toContain(`moved the database from ${old} to ${home}/.local/state/chamberlain`);
		expect(out).toContain("back on Monday");
		expect(existsSync(dbPath(old))).toBe(false);
		expect(existsSync(dbPath(`${home}/.local/state/chamberlain`))).toBe(true);
	});
});
