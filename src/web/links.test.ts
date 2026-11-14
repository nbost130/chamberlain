/**
 * Every link Chamberlain makes carries the page's key, proved through the commands themselves: `chamberlain web link`, `web rotate-token`, and
 * `chamberlain ask`, whose Decisions-thread message holds the inline view's script address.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { TOKEN_FILE } from "../core/capability.ts";
import { acceptedHosts, linkLines, linkTargets, pageBases } from "./server.ts";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function world(web: Record<string, unknown>) {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-links-`);
	dirs.push(root);
	const conf = `${root}/conf`;
	const state = `${root}/state`;
	mkdirSync(conf, { mode: 0o700 });
	mkdirSync(state, { mode: 0o700 });
	writeFileSync(
		`${conf}/config.json`,
		JSON.stringify({ schemaVersion: 1, web, threads: { decisions: "decisions-thread-id" } }),
		{ mode: 0o600 },
	);
	chmodSync(`${conf}/config.json`, 0o600);
	return { root, conf, state };
}
const run = (args: string[], env: Record<string, string>) => {
	const r = Bun.spawnSync(["bun", ...args], {
		cwd: REPO,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};
/** Like `run`, but the test's own event loop stays free, so a stub server in this process can answer the command. */
const runAsync = async (args: string[], env: Record<string, string>) => {
	const p = Bun.spawn(["bun", ...args], { cwd: REPO, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
	const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
	return { code: await p.exited, out, err };
};
const tokenIn = (conf: string) => readFileSync(`${conf}/secrets/${TOKEN_FILE}`, "utf8").trim();

describe("chamberlain web link and rotate-token", () => {
	test("the links are pure: one page link and one inline script address per address the page answers on", () => {
		const bases = pageBases({
			host: "100.64.0.5",
			port: 3790,
			allowedHosts: ["box.example.ts.net"],
			publicBase: "https://box.example.ts.net",
		});
		expect(bases).toEqual(["https://box.example.ts.net", "http://100.64.0.5:3790", "http://box.example.ts.net:3790"]);
		const text = linkLines(bases, "TOK").join("\n");
		for (const b of bases) {
			expect(text).toContain(`${b}/?k=TOK`);
			expect(text).toContain(`<script src="${b}/inline.js?view=decisions&amp;k=TOK"></script>`);
		}
		expect(pageBases({ host: "::1", port: 3790 })).toEqual(["http://[::1]:3790"]);
	});

	test("a publicBase whose host the page would refuse (421) is not printed, and is named", () => {
		const cfg = { host: "127.0.0.1", port: 3790, publicBase: "https://box.example.ts.net" };
		const t = linkTargets(cfg);
		expect(t.bases).toEqual(["http://127.0.0.1:3790"]);
		expect(t.skipped.join()).toContain('add "box.example.ts.net" to "allowedHosts"');
		const text = linkLines(t.bases, "TOK", t.skipped).join("\n");
		expect(text).not.toContain("https://box.example.ts.net/?k=");
		expect(text).toContain("Not printed, because the page would refuse it");
		// and every address that IS printed passes the page's own Host check
		for (const c of [cfg, { ...cfg, allowedHosts: ["box.example.ts.net"] }])
			for (const b of linkTargets(c).bases) expect(acceptedHosts(c)).toContain(new URL(b).host);
	});

	test("link makes the token on first use (0600 in secrets/) and prints links that carry it; rotate-token ends the old one", () => {
		const w = world({ host: "127.0.0.1", port: 3790, allowedHosts: ["h.example"] });
		const env = { CHAMBERLAIN_CONF: w.conf, CHAMBERLAIN_STATE: w.state };
		const a = run(["src/cli.ts", "web", "link"], env);
		expect(a.code, a.err).toBe(0);
		const t1 = tokenIn(w.conf);
		expect(Buffer.from(t1, "base64url")).toHaveLength(32);
		expect(statSync(`${w.conf}/secrets/${TOKEN_FILE}`).mode & 0o777).toBe(0o600);
		expect(a.out).toContain(`http://127.0.0.1:3790/?k=${t1}`);
		expect(a.out).toContain(`<script src="http://h.example:3790/inline.js?view=decisions&amp;k=${t1}"></script>`);
		expect(a.err).toBe("");
		// asking again gives the same link: `link` never changes the token
		expect(run(["src/cli.ts", "web", "link"], env).out).toContain(`?k=${t1}`);
		expect(tokenIn(w.conf)).toBe(t1);

		const b = run(["src/cli.ts", "web", "rotate-token"], env);
		expect(b.code, b.err).toBe(0);
		const t2 = tokenIn(w.conf);
		expect(t2).not.toBe(t1);
		expect(statSync(`${w.conf}/secrets/${TOKEN_FILE}`).mode & 0o777).toBe(0o600);
		expect(b.out).toContain("old link");
		expect(b.out).toContain(`?k=${t2}`);
		expect(b.out).not.toContain(t1);
		expect(run(["src/cli.ts", "web", "link"], env).out).not.toContain(t1);
	});
});

describe("chamberlain ask puts the key in the view it posts", () => {
	test("the Decisions-thread message holds the inline script address with k=<token>; nothing the command prints holds it", async () => {
		const stub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("//inline") });
		try {
			const w = world({ host: "127.0.0.1", port: stub.port });
			const { ensureToken } = await import("../core/capability.ts");
			const token = ensureToken(w.conf);
			const sent = `${w.root}/sent`;
			writeFileSync(`${w.root}/t3`, `#!/bin/sh\necho "$@" > ${sent}.args\ncat > ${sent}\n`, { mode: 0o700 });
			const q = JSON.stringify({
				kind: "product",
				title: "Which one?",
				context: "- c",
				options: [{ label: "A" }, { label: "B" }],
				thread: "t",
				server: "main",
			});
			const r = await runAsync(["src/ask.ts", q], {
				CHAMBERLAIN_CONF: w.conf,
				CHAMBERLAIN_STATE: w.state,
				T3CODE_CLI_PATH: `${w.root}/t3`,
			});
			expect(r.code, r.err).toBe(0);
			const message = readFileSync(sent, "utf8");
			expect(message).toContain(`inline.js?view=decisions&amp;item=`);
			expect(message).toContain(`&amp;k=${token}"></script>`);
			expect(r.out + r.err).not.toContain(token);
		} finally {
			stub.stop(true);
		}
	});

	test("with no key the operator gets the one-line notice, never a view whose link cannot work", async () => {
		const stub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("//inline") });
		try {
			const w = world({ host: "127.0.0.1", port: stub.port });
			const sent = `${w.root}/sent`;
			writeFileSync(`${w.root}/t3`, `#!/bin/sh\ncat > ${sent}\n`, { mode: 0o700 });
			const q = JSON.stringify({
				kind: "product",
				title: "Which one?",
				context: "- c",
				options: [{ label: "A" }, { label: "B" }],
				thread: "t",
				server: "main",
			});
			const r = await runAsync(["src/ask.ts", q], {
				CHAMBERLAIN_CONF: w.conf,
				CHAMBERLAIN_STATE: w.state,
				T3CODE_CLI_PATH: `${w.root}/t3`,
			});
			expect(r.code, r.err).toBe(0);
			expect(readFileSync(sent, "utf8")).not.toContain("inline.js");
			expect(r.err).toContain("chamberlain web link");
		} finally {
			stub.stop(true);
		}
	});
});
