/** ask, continued: see ask.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { queueBase, stageEvidence } from "./ask.ts";
import type { Question } from "./core/items/questions.ts";
import { base, ID, mk } from "./testing/ask-fixtures.ts";

describe("stageEvidence", () => {
	const dir = () => mkdtempSync(`${tmpdir()}/chamberlain-stage-`);
	const itemOf = (evidence: Question["evidence"]): Question => ({ ...mk({}), evidence });
	test("an item with no evidence comes back as it is", () => {
		const q = mk({});
		expect(stageEvidence(q, dir())).toBe(q);
		const empty = itemOf([]);
		expect(stageEvidence(empty, dir())).toBe(empty);
	});
	test("a link stays; a file is copied under a safe, unique name and its path becomes that name", () => {
		const d = dir();
		mkdirSync(`${d}/a`);
		mkdirSync(`${d}/b`);
		writeFileSync(`${d}/a/Shot (1).PNG`, "one");
		writeFileSync(`${d}/b/Shot (1).PNG`, "two");
		writeFileSync(`${d}/a/.hidden.mp4`, "vid");
		const out = stageEvidence(
			itemOf([
				{ type: "image", path: `${d}/a/Shot (1).PNG`, caption: "x" },
				{ type: "link", url: "https://x" },
				{ type: "image", path: `${d}/b/Shot (1).PNG` },
				{ type: "video", path: `${d}/a/.hidden.mp4` },
			]),
			`${d}/state`,
		);
		expect(out.evidence).toEqual([
			{ type: "image", path: "Shot__1_.PNG", caption: "x" },
			{ type: "link", url: "https://x" },
			{ type: "image", path: "3-Shot__1_.PNG" },
			{ type: "video", path: "hidden.mp4" },
		]);
		expect(Bun.file(`${d}/state/evidence/${ID}/Shot__1_.PNG`).size).toBe(3);
		expect(Bun.file(`${d}/state/evidence/${ID}/3-Shot__1_.PNG`).size).toBe(3);
	});
	test("a leading ~/ is the home directory", () => {
		const home = process.env.HOME ?? "";
		const name = `chamberlain-home-${process.pid}.png`;
		writeFileSync(`${home}/${name}`, "png");
		const out = stageEvidence(itemOf([{ type: "image", path: `~/${name}` }]), dir());
		expect(out.evidence?.[0]?.path).toBe(name);
	});
	test("a missing file, a directory, a symlink and a wrong extension are refused, naming the entry", () => {
		const d = dir();
		mkdirSync(`${d}/folder.png`);
		writeFileSync(`${d}/real.png`, "x");
		writeFileSync(`${d}/notes.txt`, "x");
		symlinkSync(`${d}/real.png`, `${d}/link.png`);
		const stage = (e: NonNullable<Question["evidence"]>[number]) => () =>
			stageEvidence(itemOf([{ type: "link", url: "https://x" }, e]), d);
		for (const p of [`${d}/nope.png`, `${d}/folder.png`, `${d}/link.png`])
			expect(stage({ type: "image", path: p })).toThrow(`ask: evidence 2 is not a regular file: ${p}`);
		expect(stage({ type: "image", path: `${d}/notes.txt` })).toThrow("ask: evidence 2 must be png, jpg, gif or webp");
		expect(stage({ type: "video", path: `${d}/real.png` })).toThrow("ask: evidence 2 must be mp4, webm or mov");
	});
});

describe("queueBase", () => {
	const conf = (web: unknown) => {
		const c = mkdtempSync(`${tmpdir()}/chamberlain-qb-`);
		chmodSync(c, 0o700);
		if (web !== undefined) writeFileSync(`${c}/web.json`, JSON.stringify(web), { mode: 0o600 });
		return c;
	};
	test("an https publicBase wins; otherwise host and port, bracketed for an IPv6 host; otherwise none", () => {
		expect(queueBase(conf({ host: "127.0.0.1", port: 3790, publicBase: "https://box.example" }))).toBe(
			"https://box.example",
		);
		expect(queueBase(conf({ host: "127.0.0.1", port: 3790, publicBase: "http://box.example" }))).toBe(
			"http://127.0.0.1:3790",
		);
		expect(queueBase(conf({ host: "127.0.0.1", port: 3790, publicBase: "https://box.example/x" }))).toBe(
			"http://127.0.0.1:3790",
		);
		expect(queueBase(conf({ host: "::1", port: 3790 }))).toBe("http://[::1]:3790");
		expect(queueBase(conf({ host: "127.0.0.1" }))).toBeUndefined();
		expect(queueBase(conf({ port: 3790 }))).toBeUndefined();
		expect(queueBase(conf(undefined))).toBeUndefined();
	});
	test("a web.json that cannot be read means no page", () => {
		const c = conf({ host: "127.0.0.1", port: 3790 });
		chmodSync(`${c}/web.json`, 0o644);
		expect(queueBase(c)).toBeUndefined();
	});
});

describe("main: the inline view's key", () => {
	const urgent = { ...base, kind: "product", tag: "Approval", proposedRuling: undefined, notSettled: "test" };
	function scratch(web: { host: string; port: number } | undefined, token?: { text: string; mode: number }) {
		const d = mkdtempSync(`${tmpdir()}/chamberlain-askmain-`);
		mkdirSync(`${d}/state`);
		mkdirSync(`${d}/conf/secrets`, { recursive: true, mode: 0o700 });
		chmodSync(`${d}/conf`, 0o700);
		if (web) writeFileSync(`${d}/conf/web.json`, JSON.stringify(web), { mode: 0o600 });
		if (token) writeFileSync(`${d}/conf/secrets/view-key`, token.text, { mode: token.mode });
		if (token) chmodSync(`${d}/conf/secrets/view-key`, token.mode);
		return d;
	}
	async function run(d: string, ...args: string[]) {
		const {
			XDG_STATE_HOME: _s,
			XDG_CACHE_HOME: _c,
			XDG_CONFIG_HOME: _f,
			CHAMBERLAIN_STATE: _a,
			CHAMBERLAIN_CONF: _g,
			...rest
		} = process.env;
		const p = Bun.spawn([process.execPath, new URL("./ask.ts", import.meta.url).pathname, ...args], {
			env: { ...rest, HOME: d, CHAMBERLAIN_STATE: `${d}/state`, CHAMBERLAIN_CONF: `${d}/conf` },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		return { out, err, code };
	}
	const ask = (d: string) => run(d, JSON.stringify(urgent));
	const withPage = async (fn: (port: number) => Promise<void>) => {
		const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("//js") });
		try {
			await fn(server.port ?? 0);
		} finally {
			server.stop(true);
		}
	};
	test("no argument is a usage error", async () => {
		const r = await run(scratch(undefined));
		expect([r.code, r.err]).toEqual([2, "usage: ask.ts '<json>' | ask.ts - < item.json\n"]);
	});
	test("the JSON may come on stdin", async () => {
		const d = scratch(undefined);
		const p = Bun.spawn([process.execPath, new URL("./ask.ts", import.meta.url).pathname, "-"], {
			env: { ...process.env, HOME: d, CHAMBERLAIN_STATE: `${d}/state`, CHAMBERLAIN_CONF: `${d}/conf` },
			stdin: new Blob([JSON.stringify({ ...urgent, tag: undefined, urgent: false })]),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await new Response(p.stdout).text()).toMatch(
			/^Q-\w+ \(on the queue page, not urgent: no notification sent\)\n$/,
		);
		expect(await p.exited).toBe(0);
	});
	test("a page that answers but has no key yet says so, and the post still goes on", async () => {
		await withPage(async (port) => {
			const r = await ask(scratch({ host: "127.0.0.1", port }));
			expect(r.err).toContain(
				"the page has no view key yet: start the page (chamberlain web); posting a notice instead of the view",
			);
			expect(r.err).toContain("ask: the Decisions thread is not set (threads.decisions in config.json)");
			expect(r.code).toBe(1);
		});
	});
	test("a key that cannot be read says why (and, having none, that there is none), and the post still goes on", async () => {
		await withPage(async (port) => {
			const r = await ask(scratch({ host: "127.0.0.1", port }, { text: "k".repeat(43), mode: 0o644 }));
			expect(r.err).toContain(
				"the view key could not be read (view-key must be a private regular file with mode exactly 0600",
			);
			expect(r.err).toContain("posting a notice instead of the view");
			// An unreadable key also leaves no key, so the second notice follows the first.
			expect(r.err).toContain("the page has no view key yet");
			expect(r.code).toBe(1);
		});
	});
	test("a readable key, or a page that does not answer, prints neither notice", async () => {
		await withPage(async (port) => {
			const r = await ask(scratch({ host: "127.0.0.1", port }, { text: "k".repeat(43), mode: 0o600 }));
			expect(r.err).not.toContain("key");
			expect(r.code).toBe(1);
		});
		const down = await ask(scratch({ host: "127.0.0.1", port: 9 }));
		expect(down.err).not.toContain("key");
		expect(down.code).toBe(1);
		const unset = await ask(scratch(undefined));
		expect(unset.err).not.toContain("key");
	});
});
