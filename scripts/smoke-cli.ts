/** The smoke test's checks of the binary's own commands: its version and help, the briefs, the daemon, the config and the ledgers. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { bin, check, empty, env, exec, port, ROOT } from "./smoke-lib.ts";

/** `--version`, `help` and an unknown command. */
export function smokeBasics() {
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
}

/** A new Steward needs no checkout: its first message and its wake task's prompt come out of the binary. */
export function smokeBriefs() {
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
}

/** The daemon, dry (no wakes sent), with no servers configured: it takes the relay lock, opens the database and stays up. */
export async function smokeDaemon() {
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
}

/** Every command the hand-offs teach is `chamberlain <sub>`, and nothing names a checkout or Bun's embedded filesystem. */
export function smokeHandoffs() {
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
}

/** The config command: the new layout reads back, and a dry-run migration has nothing to do (the smoke config is already new). */
export function smokeConfig() {
	const shown = exec("config", "show");
	check(
		"config show reads config.json",
		shown.exitCode === 0 && shown.stdout.toString().includes("config.json  present"),
		`exit ${shown.exitCode}: ${shown.stdout}${shown.stderr}`,
	);
	const got = exec("config", "get", "web.port");
	check(
		"config get web.port prints the port",
		got.exitCode === 0 && got.stdout.toString().trim() === String(port),
		`exit ${got.exitCode}: ${got.stdout}${got.stderr}`,
	);
	const refused = exec("config", "get", "wake-url");
	check(
		"config get refuses a secret, with exit 1 and nothing on stdout",
		refused.exitCode === 1 && refused.stdout.toString() === "",
		`exit ${refused.exitCode}: ${refused.stdout}`,
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
}

/** The sweep prompt is read by the daemon at run time; it must be inside the binary. */
export function smokeSweepPrompt() {
	const sweepLine = readFileSync(join(ROOT, "docs/steward-sweep-prompt.md"), "utf8")
		.split("\n")
		.find((l) => l.startsWith("1. ") || l.startsWith("2. "));
	if (sweepLine === undefined)
		throw Error("docs/steward-sweep-prompt.md has no numbered step to look for in the binary");
	const sweep = sweepLine.slice(0, 60);
	check(
		"the sweep prompt is embedded in the binary",
		Buffer.from(readFileSync(bin)).includes(Buffer.from(sweep)),
		sweep,
	);
}
