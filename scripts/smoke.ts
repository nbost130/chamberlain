/**
 * Smoke test for a compiled binary: `bun scripts/smoke.ts <binary | release tarball>`.
 *
 * Runs the binary from an EMPTY temporary directory, with HOME, CHAMBERLAIN_CONF and CHAMBERLAIN_STATE pointed at scratch directories, so
 * nothing it needs can come from a checkout or from Bun: `--version`, `help`, `web --test` serving the page, its CSS and its scripts (each
 * byte for byte what src/web/static/ holds), an `ask` that a second process (the page) then reads back from the scratch database, the
 * hand-offs rendering `chamberlain <sub>` for every command they teach, and the sweep prompt embedded in the binary.
 * Exits 1 at the first thing that is wrong. Needs a binary built for the machine it runs on.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };

const ROOT = resolve(import.meta.dir, "..");
const input = process.argv[2];
if (!input || !existsSync(input)) {
	console.error("usage: bun scripts/smoke.ts <binary | chamberlain-<version>-<os>-<arch>.tar.gz>");
	process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "chamberlain-smoke-"));
const empty = join(work, "empty"); // the working directory of every run: nothing is in it
const conf = join(work, "conf");
const state = join(work, "state");
for (const d of [empty, state]) mkdirSync(d, { recursive: true });
mkdirSync(conf, { recursive: true, mode: 0o700 });
let bin = resolve(input);
if (basename(bin).endsWith(".tar.gz")) {
	const unpacked = join(work, "unpacked");
	mkdirSync(unpacked);
	const t = Bun.spawnSync(["tar", "-xzf", bin, "-C", unpacked]);
	if (t.exitCode !== 0) throw Error(`tar failed: ${t.stderr.toString()}`);
	bin = join(unpacked, "chamberlain");
}

const port = 40000 + Math.floor(Math.random() * 20000);
writeFileSync(join(conf, "config.json"), JSON.stringify({ schemaVersion: 1, web: { host: "127.0.0.1", port } }), {
	mode: 0o600,
});
const env: Record<string, string> = {
	PATH: "/usr/bin:/bin",
	HOME: work,
	CHAMBERLAIN_CONF: conf,
	CHAMBERLAIN_STATE: state,
	CHAMBERLAIN_T3_STATE_DB: join(work, "no-t3.sqlite"),
};
const exec = (...args: string[]) => Bun.spawnSync([bin, ...args], { cwd: empty, env, stdout: "pipe", stderr: "pipe" });

let failed = false;
const ok = (what: string) => console.log(`ok   ${what}`);
const bad = (what: string, detail = "") => {
	failed = true;
	console.log(`FAIL ${what}${detail ? `\n       ${detail.split("\n").join("\n       ")}` : ""}`);
};
const check = (what: string, cond: boolean, detail = "") => (cond ? ok(what) : bad(what, detail));

try {
	console.log(`binary: ${bin}\ncwd:    ${empty} (empty)\n`);

	const v = exec("--version");
	check(
		`--version prints ${pkg.version}`,
		v.exitCode === 0 && v.stdout.toString().trim() === pkg.version,
		`exit ${v.exitCode}: ${v.stdout}${v.stderr}`,
	);
	const h = exec("help");
	check(
		"help lists every command",
		h.exitCode === 0 && ["daemon", "web", "ask", "afk", "brief", "debug"].every((c) => h.stdout.toString().includes(c)),
	);
	check("an unknown command exits 2", exec("nope").exitCode === 2);
	// A new Steward needs no checkout: its first message and its wake task's prompt come out of the binary.
	const start = exec("brief", "start");
	check(
		"brief start prints the first Steward message with `chamberlain` commands",
		start.exitCode === 0 &&
			start.stdout.toString().includes("`chamberlain switch-steward <your thread id>`") &&
			!/\{\{|bun /.test(start.stdout.toString()),
		`exit ${start.exitCode}: ${start.stdout}${start.stderr}`,
	);
	const wake = exec("brief", "wake-prompt");
	check(
		"brief wake-prompt prints the wake task's prompt",
		wake.exitCode === 0 && wake.stdout.toString().startsWith("/steward-wake"),
		`exit ${wake.exitCode}: ${wake.stdout}${wake.stderr}`,
	);
	// A diagnostic command under `debug`, and by the old name a prompt written before the grouping still uses.
	for (const argv of [
		["debug", "desk-allowlist", "check", "journalctl -n 5"],
		["desk-allowlist", "check", "journalctl -n 5"],
	]) {
		const d = exec(...argv);
		check(
			`\`chamberlain ${argv.slice(0, argv[0] === "debug" ? 2 : 1).join(" ")}\` runs`,
			d.exitCode === 0 && d.stdout.toString().trim() === "allow",
			`exit ${d.exitCode}: ${d.stdout}${d.stderr}`,
		);
	}

	// The page, from the embedded files, and a question asked by another process shows up on it.
	const page = Bun.spawn([bin, "web", "--test"], { cwd: empty, env, stdout: "pipe", stderr: "pipe" });
	try {
		const reader = page.stdout.getReader();
		let out = "";
		const deadline = Date.now() + 15_000;
		while (!out.includes("decision queue on") && Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) break;
			out += new TextDecoder().decode(value);
		}
		check(
			"web --test starts",
			out.includes(`http://127.0.0.1:${port}`),
			out || (await new Response(page.stderr).text()),
		);
		const base = `http://127.0.0.1:${port}`;
		// The page's capability token: made at its first start, in secrets/. Without it nothing but the static code is served.
		const tokenFile = join(conf, "secrets", "web-token");
		const token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
		check(
			"the page made its capability token (43 characters, mode 0600)",
			token.length === 43 && (statSync(tokenFile).mode & 0o777) === 0o600,
		);
		const key = { "x-decision-token": token };
		const nokey = await fetch(`${base}/api/queue`);
		check("GET /api/queue with no key is 401", nokey.status === 401, `status ${nokey.status}`);
		const nullNoKey = await fetch(`${base}/api/queue`, { headers: { origin: "null" } });
		check("a null-origin GET /api/queue with no key is 401", nullNoKey.status === 401, `status ${nullNoKey.status}`);
		const wrong = await fetch(`${base}/api/queue`, { headers: { "x-decision-token": `${token.slice(0, -1)}x` } });
		check("a wrong key is 401", wrong.status === 401, `status ${wrong.status}`);
		const locked = await fetch(`${base}/`);
		check(
			"GET / with no key is the 401 'needs its link' page",
			locked.status === 401 && (await locked.text()).includes("chamberlain web link"),
		);
		const linked = await fetch(`${base}/?k=${token}`, { redirect: "manual" });
		check(
			"GET /?k=<key> is a 303 to / that sets the cookie",
			linked.status === 303 &&
				linked.headers.get("location") === "/" &&
				(linked.headers.get("set-cookie") ?? "").startsWith("dq_cap="),
			`status ${linked.status}`,
		);
		const link = exec("web", "link");
		check(
			"`chamberlain web link` prints the page link and the inline script address with the key",
			link.exitCode === 0 &&
				link.stdout.toString().includes(`/?k=${token}`) &&
				link.stdout.toString().includes(`inline.js?view=decisions&amp;k=${token}`),
			`exit ${link.exitCode}: ${link.stderr}`,
		);
		const files: [string, string, string][] = [
			["/", "index.html", "text/html"],
			["/app.css", "app.css", "text/css"],
			["/app.js", "app.js", "text/javascript"],
			["/inline.js", "inline.js", "text/javascript"],
		];
		for (const [url, file, type] of files) {
			const r = await fetch(base + url, { headers: key });
			const body = new Uint8Array(await r.arrayBuffer());
			const want = new Uint8Array(readFileSync(join(ROOT, "src/web/static", file)));
			check(
				`GET ${url} is 200 ${type} and is src/web/static/${file} byte for byte (${body.length} bytes)`,
				r.status === 200 && (r.headers.get("content-type") ?? "").startsWith(type) && Buffer.compare(body, want) === 0,
				`status ${r.status}, type ${r.headers.get("content-type")}, ${body.length} bytes vs ${want.length}`,
			);
		}
		const q = JSON.stringify({
			kind: "product",
			title: "Smoke: which colour?",
			context: "- asked by scripts/smoke.ts",
			options: [{ label: "Blue" }, { label: "Green" }],
			thread: "Smoke",
			server: "main",
			urgent: false,
		});
		const a = exec("ask", q);
		const id = a.stdout.toString().match(/\bQ-[a-z0-9]{4,16}\b/)?.[0];
		check(
			"ask files the question into the scratch state directory",
			a.exitCode === 0 && id !== undefined,
			`exit ${a.exitCode}: ${a.stdout}${a.stderr}`,
		);
		check("ask wrote the database under the scratch state dir", existsSync(join(state, "chamberlain.db")));
		const queue = await (await fetch(`${base}/api/queue`, { headers: key })).text();
		check(
			"the page (another process) reads that question back from the database",
			id !== undefined && queue.includes(id) && queue.includes("Smoke: which colour?"),
			queue.slice(0, 300),
		);
	} finally {
		page.kill();
		await page.exited;
	}

	// The daemon, dry (no wakes sent), with no servers configured: it takes the relay lock, opens the database and stays up.
	const daemon = Bun.spawn([bin, "daemon"], {
		cwd: empty,
		env: { ...env, CHAMBERLAIN_DRY: "1" },
		stdout: "pipe",
		stderr: "pipe",
	});
	await Bun.sleep(3000);
	const up = daemon.exitCode === null;
	daemon.kill();
	await daemon.exited;
	check("daemon starts and stays up", up, await new Response(daemon.stderr).text());

	// Every command the hand-offs teach is `chamberlain <sub>`, and nothing names a checkout or Bun's embedded filesystem.
	const brief = exec("brief", "steward", "--mode", "live");
	const text = brief.stdout.toString();
	check("brief steward renders", brief.exitCode === 0 && text.length > 1000, `exit ${brief.exitCode}: ${brief.stderr}`);
	for (const c of [
		"chamberlain ask '<json>'",
		"chamberlain afk hold",
		"chamberlain afk held",
		"chamberlain decided list 15",
		"chamberlain ruling",
		"chamberlain debug peek <server> <threadId>",
		"chamberlain debug t3x threads|read|respond|send <server>",
	])
		check(`the hand-off teaches \`${c}\``, text.includes(c));
	check(
		"the hand-off names no `bun ...src/` command and no $bunfs path",
		!/\bbun \S*\/src\//.test(text) && !text.includes("$bunfs") && !text.includes("~BUN"),
		(text.match(/.{0,60}(\bbun \S*\/src\/|\$bunfs).{0,60}/) ?? [""])[0],
	);
	const desk = exec("brief", "desk");
	check(
		"brief desk renders the embedded prompt with `chamberlain ask '{`",
		desk.exitCode === 0 &&
			desk.stdout.toString().includes("chamberlain ask '{") &&
			desk.stdout.toString().includes("`chamberlain debug desk-allowlist hook`"),
		`exit ${desk.exitCode}: ${desk.stderr}`,
	);
	const allow = exec("desk-allowlist", "check", 'chamberlain ask \'{"kind":"product"}\'');
	check(
		"desk-allowlist allows `chamberlain ask '<json>'`",
		allow.exitCode === 0 && allow.stdout.toString().trim() === "allow",
		`${allow.stdout}${allow.stderr}`,
	);
	// The config command: the new layout reads back, and a dry-run migration has nothing to do (the smoke config is already new).
	const shown = exec("config", "show");
	check(
		"config show reads config.json",
		shown.exitCode === 0 && shown.stdout.toString().includes("config.json  present"),
		`exit ${shown.exitCode}: ${shown.stdout}${shown.stderr}`,
	);
	const dry = exec("config", "migrate", "--dry-run");
	check(
		"config migrate --dry-run finds nothing to do",
		dry.exitCode === 0 && dry.stdout.toString().includes("nothing to do"),
		`exit ${dry.exitCode}: ${dry.stdout}${dry.stderr}`,
	);
	const held = exec("afk", "held");
	check("afk held runs", held.exitCode === 0, held.stderr.toString());
	const logged = exec("decided", "Smoke", "kept the default", "R1: smoke");
	check(
		"decided logs",
		logged.exitCode === 0 && exec("decided", "list").stdout.toString().includes("kept the default"),
	);
	// The sweep prompt is read by the daemon at run time; it must be inside the binary.
	const sweep = readFileSync(join(ROOT, "docs/steward-sweep-prompt.md"), "utf8")
		.split("\n")
		.find((l) => l.startsWith("1. ") || l.startsWith("2. "))!
		.slice(0, 60);
	check(
		"the sweep prompt is embedded in the binary",
		Buffer.from(readFileSync(bin)).includes(Buffer.from(sweep)),
		sweep,
	);
} finally {
	rmSync(work, { recursive: true, force: true });
}

console.log(failed ? "\nsmoke test FAILED" : "\nsmoke test passed");
process.exit(failed ? 1 : 0);
