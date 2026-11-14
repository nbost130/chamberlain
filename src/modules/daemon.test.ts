/**
 * The real daemon, started against a scratch config and state directory, with the email triage module absent and then on. "Off means
 * absent" is proved here at the process: with no `mail` section the daemon makes no mail.db, writes no `mail.*` event and has no child
 * process; with the section it makes mail.db and says so once. Nothing is read from or sent to a mailbox: B1 has no mail access.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../core/sqlite-store.ts";
import { dbPath, type Store } from "../core/store.ts";
import { mailDbPath } from "./mail/db.ts";

const DAEMON = new URL("../daemon.ts", import.meta.url).pathname;
const procs: { kill: (s?: number) => void; exited: Promise<number> }[] = [];
const stores: Store[] = [];
afterEach(async () => {
	for (const p of procs.splice(0)) {
		p.kill(9);
		await p.exited;
	}
	for (const s of stores.splice(0)) s.close();
});

const secret = (p: string, body: string) => {
	writeFileSync(p, body, { mode: 0o600 });
	chmodSync(p, 0o600);
};

/** A scratch world: a config directory whose one server is a port nothing listens on (the daemon starts, recovers and retries quietly). */
function world(mail?: object) {
	const root = mkdtempSync(join(tmpdir(), "mail-daemon-"));
	const conf = join(root, "conf"),
		state = join(root, "state");
	mkdirSync(conf, { recursive: true, mode: 0o700 });
	mkdirSync(state, { recursive: true, mode: 0o700 });
	secret(join(conf, "wake-url"), "http://127.0.0.1:9/wake");
	secret(
		join(conf, "servers.json"),
		JSON.stringify({
			servers: [{ name: "test", origin: "http://127.0.0.1:9", tokenFile: "read-token", mayBeOffline: true }],
		}),
	);
	secret(join(conf, "read-token"), "not-a-token");
	if (mail) secret(join(conf, "config.json"), JSON.stringify({ mail }));
	const store = openStore(dbPath(state));
	stores.push(store);
	const events = (names: string[]) => store.events.query({ events: names }) as { event: string }[];
	const daemon = () => {
		const p = Bun.spawn(["bun", DAEMON], {
			env: {
				...process.env,
				HOME: root,
				CHAMBERLAIN_CONF: conf,
				CHAMBERLAIN_STATE: state,
				CHAMBERLAIN_T3_STATE_DB: join(root, "none.sqlite"),
				CHAMBERLAIN_DRY: "0",
			},
			stdout: "ignore",
			stderr: "pipe",
		});
		procs.push(p);
		return p;
	};
	const until = async (what: string, ok: () => boolean, ms = 20_000) => {
		const end = Date.now() + ms;
		while (!ok()) {
			if (Date.now() > end) throw Error(`timed out waiting for ${what}`);
			await Bun.sleep(25);
		}
	};
	return { conf, state, events, daemon, until };
}

/** The command lines of a process's direct children. */
const childrenOf = async (pid: number): Promise<string[]> => {
	const p = Bun.spawn(["ps", "-o", "args=", "--ppid", String(pid)], { stdout: "pipe", stderr: "ignore" });
	const out = await new Response(p.stdout).text();
	await p.exited;
	return out.split("\n").filter(Boolean);
};

describe("the real daemon", () => {
	test("with no mail section: no mail.db, no mail.* event and no child process", async () => {
		const w = world();
		const p = w.daemon();
		await w.until("the daemon's first pass", () => w.events(["startup-recovered"]).length > 0);
		await Bun.sleep(500);
		expect(existsSync(mailDbPath(w.state))).toBe(false);
		expect(w.events(["mail.start", "mail.run", "mail.attempt"])).toEqual([]);
		expect((await childrenOf(p.pid)).filter((c) => /mail|claude|gog/.test(c))).toEqual([]);
		expect(readdirSync(w.state).filter((f) => f.startsWith("mail"))).toEqual([]);
	}, 30_000);

	test('with "provider": "none": the same, whatever else the section says', async () => {
		const w = world({ provider: "none", mode: "live", allowMailToLeaveMachine: true });
		w.daemon();
		await w.until("the daemon's first pass", () => w.events(["startup-recovered"]).length > 0);
		await Bun.sleep(500);
		expect(existsSync(mailDbPath(w.state))).toBe(false);
		expect(w.events(["mail.start"])).toEqual([]);
	}, 30_000);

	test("with the module on: mail.db is made on the first start, one mail.start is written, and still no child process", async () => {
		const w = world({ provider: "gog", allowMailToLeaveMachine: true, gog: { command: "/nonexistent/gog" } });
		const p = w.daemon();
		await w.until("mail.start", () => w.events(["mail.start"]).length > 0);
		expect(existsSync(mailDbPath(w.state))).toBe(true);
		expect(w.events(["mail.start"])).toHaveLength(1);
		expect((await childrenOf(p.pid)).filter((c) => /mail|claude|gog/.test(c))).toEqual([]);
	}, 30_000);

	test("a section the module cannot parse stops the daemon before it serves anything, naming the key", async () => {
		const w = world({ provider: "gog", allowMailToLeaveMachine: true, password: "hunter2" });
		const p = w.daemon();
		await p.exited;
		const err = await new Response(p.stderr).text();
		expect(p.exitCode).not.toBe(0);
		expect(err).toContain('mail: unknown key "password"');
		expect(err).not.toContain("hunter2");
		expect(existsSync(mailDbPath(w.state))).toBe(false);
	}, 30_000);
});
