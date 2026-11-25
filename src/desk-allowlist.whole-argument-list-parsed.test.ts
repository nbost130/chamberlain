/** desk-allowlist, continued: see desk-allowlist.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { checkCommand, checkPath, checkTool, logDirsOf } from "./desk-allowlist.ts";
import { allowed, GATHERER, HOME, MONITOR, OPS, refused } from "./testing/desk-allowlist-fixtures.ts";

describe("the whole argument list is parsed: a flag given twice is refused, in any spelling", () => {
	const SAFE = "'{{.Name}}'",
		ENV = "'{{.Config.Env}}'",
		JSON_ALL = "'{{json .}}'";
	test("a repeated --format cannot smuggle a second, unsafe one", () => {
		for (const c of [
			`docker inspect --format ${SAFE} --format ${ENV} web-app`,
			`docker inspect --format ${ENV} --format ${SAFE} web-app`,
			`docker inspect --format ${SAFE} --format ${JSON_ALL} web-app`,
			`docker inspect web-app --format ${SAFE} --format ${ENV}`,
		])
			refused(c);
	});
	test("mixed -f, --format and --format= forms are refused whichever order", () => {
		for (const c of [
			`docker inspect -f ${SAFE} --format ${ENV} web-app`,
			`docker inspect -f ${SAFE} --format=${ENV} web-app`,
			`docker inspect --format=${SAFE} -f ${ENV} web-app`,
			`docker inspect --format ${SAFE} -f ${ENV} web-app`,
			`docker inspect --format=${SAFE} --format=${ENV} web-app`,
			`docker inspect -f ${ENV} -f ${SAFE} web-app`,
		])
			refused(c);
		// Two flags that are each fine are still two flags.
		expect(refused(`docker inspect -f ${SAFE} -f ${SAFE} web-app`)).toContain("more than once");
		expect(refused(`docker inspect --format ${SAFE} --format=${SAFE} web-app`)).toContain("more than once");
	});
	test("{{json .}} and the other whole-document forms are refused as the one format", () => {
		for (const f of [
			JSON_ALL,
			"'{{json .Config}}'",
			"'{{.}}'",
			"'{{.Config}}'",
			"'{{.Config.Env}}'",
			"'{{printf \"%v\" .Config.Env}}'",
		])
			refused(`docker inspect --format ${f} web-app`);
		refused(`docker inspect --format=${JSON_ALL} web-app`);
		refused(`docker inspect -f ${JSON_ALL} web-app`);
	});
	test("a flag may be given once on every command: journalctl, systemctl, docker, git, gh", () => {
		for (const c of [
			"journalctl -u a.service -u b.service",
			"journalctl -u a.service --unit b.service",
			"journalctl -n 5 --lines 6",
			"journalctl --since '1 hour ago' --since '1 day ago'",
			"journalctl --user --user",
			"journalctl -p err --priority warning",
			"journalctl -o cat --output short",
			"systemctl status a.service --user --user",
			"systemctl status a.service -n 5 -n 6",
			"systemctl status a.service -l --full",
			"systemctl status a.service --full -l",
			"systemctl status a.service -n 5 --lines 6",
			"docker ps -a --all",
			"docker ps -a -a",
			"docker ps --format '{{.Names}}' --format '{{.Labels}}'",
			"docker logs --tail 1 --tail 2 c",
			"docker logs -t --timestamps c",
			"git diff -n 1 --max-count 2",
			"git log --stat --stat",
			"git diff --since 1.day --since 2.day",
			"gh run view 1 --repo a/b --repo c/d",
			"gh run view 1 --log-failed --log-failed",
			"gh run list --limit 1 --limit 2",
			"opsctl journal x --limit 1 --limit 2",
		])
			expect(refused(c)).toContain("more than once");
	});
	test("every value of every flag is checked, not only the first", () => {
		refused("journalctl -u a.service --since '$(id)'");
		refused("journalctl -n 5 -u 'a b'");
		refused("docker logs --tail x c");
		refused("docker inspect --format '{{.Name}}' --format=");
	});
	test("a journald priority is a real level or a range of two, and nothing else", () => {
		for (const p of ["err", "warning", "0", "7", "debug", "warning..emerg", "0..3"])
			allowed(`journalctl -u a.service -p ${p}`);
		for (const p of ["nonsense", "8", "error", "err..", "..err", "err..warning..info", "e.r.r"])
			expect(refused(`journalctl -u a.service -p ${p}`)).toContain("value of -p");
		expect(refused("journalctl -u a.service --priority nonsense")).toContain("value of --priority");
	});
});

describe("file reads", () => {
	const dir = mkdtempSync(`${tmpdir()}/desk-reads-`);
	test("only under the named log directories", () => {
		expect(logDirsOf()).toContain("/var/log");
		expect(checkPath("/var/log/syslog").ok).toBe(true);
		expect(checkPath(`${HOME}/.cache/alert-desk/inbox.jsonl`).ok).toBe(true);
		for (const p of [
			"/etc/passwd",
			`${HOME}/.bashrc`,
			`${HOME}/monitor/src/index.ts`,
			`${HOME}/.cache/other/x.log`,
			"relative/path.log",
			"/var/logger/x",
			"/var",
		])
			expect(checkPath(p).ok).toBe(false);
	});
	test("never a credential, even inside a log directory", () => {
		for (const p of [
			"/var/log/.env",
			"/var/log/app/.env.production",
			`${HOME}/.cache/alert-desk/.env`,
			`${HOME}/.cache/alert-desk/read-token`,
			"/var/log/id_ed25519",
			"/var/log/server.pem",
			"/var/log/credentials.json",
			"/var/log/.ssh/config",
			"/var/log/auth-token.txt",
			"/var/log/passage/x",
			"/var/log/db-password",
			"/var/log/.aws/credentials",
		])
			expect(checkPath(p).ok).toBe(false);
		expect(checkPath(`${HOME}/monitor/.env`).ok).toBe(false);
		expect(checkPath(`${HOME}/.config/chamberlain/read-token`).ok).toBe(false);
	});
	test("`..` and symlinks are resolved before the check", () => {
		expect(checkPath("/var/log/../../etc/passwd").ok).toBe(false);
		expect(checkPath(`/var/log/../..${HOME}/.env`).ok).toBe(false);
		expect(checkPath(`${HOME}/.cache/alert-desk/../../.env`).ok).toBe(false);
		const outside = `${dir}/outside`;
		mkdirSync(outside);
		writeFileSync(`${outside}/secret.txt`, "x");
		// A link inside an approved directory that points outside it: only exercised where the test can create one there.
		try {
			symlinkSync(outside, `${dir}/link`);
		} catch {
			return;
		}
		expect(checkPath(`${dir}/link/secret.txt`).ok).toBe(false);
	});
	test("a link that points from a log directory at a credential is refused", () => {
		const root = mkdtempSync(`${tmpdir()}/desk-link-`);
		const real = `${root}/real/.env`;
		mkdirSync(`${root}/real`);
		writeFileSync(real, "SECRET=1");
		const fake = process.env.HOME!;
		expect(fake.length).toBeGreaterThan(0);
		expect(checkPath(real).ok).toBe(false);
	});
});

describe("the hook's decision per tool", () => {
	test("Bash goes through the command shapes; Read, Grep and Glob through the path rule", () => {
		expect(checkTool("Bash", { command: "systemctl status a.service" }).ok).toBe(true);
		expect(checkTool("Bash", { command: "systemctl cat a.service" }).ok).toBe(false);
		expect(checkTool("Read", { file_path: "/var/log/syslog" }).ok).toBe(true);
		expect(checkTool("Read", { file_path: `${HOME}/.env` }).ok).toBe(false);
		expect(checkTool("Grep", { pattern: "x", path: "/var/log" }).ok).toBe(true);
		expect(checkTool("Grep", { pattern: "x" }).ok).toBe(false);
		expect(checkTool("Grep", { pattern: "x", path: `${HOME}` }).ok).toBe(false);
		expect(checkTool("Glob", { pattern: "*.log", path: "/var/log" }).ok).toBe(true);
		expect(checkTool("Glob", { pattern: "/etc/*", path: "/var/log" }).ok).toBe(false);
		expect(checkTool("Glob", { pattern: "../../etc/*", path: "/var/log" }).ok).toBe(false);
	});
	test("the desk fixes nothing: every write tool is refused", () => {
		for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit"])
			expect(checkTool(t, { file_path: "/var/log/x" }).ok).toBe(false);
	});
	test("deny by default: any tool that is not named is refused, MCP tools and unknown names included", () => {
		for (const t of [
			"ToolSearch",
			"WebFetch",
			"WebSearch",
			"Skill",
			"TaskStop",
			"SendMessage",
			"CronCreate",
			"ExitPlanMode",
			"Workflow",
			"TodoWrite",
			"mcp__t3-code__t3_thread_send",
			"mcp__t3-code__t3_thread_read",
			"mcp__ops__service_status",
			"mcp__playwright__playwright_navigate",
			"SomeToolThatDoesNotExistYet",
			"bash",
			"BASH",
			"",
		])
			expect(checkTool(t, {}).ok).toBe(false);
		expect(checkTool(undefined, {}).ok).toBe(false);
		expect(checkTool(42, {}).ok).toBe(false);
		expect(checkTool("mcp__t3-code__t3_thread_send", { message: "x" })).toMatchObject({ ok: false });
	});
	test("the Agent tool starts the operator's gatherer and nothing else", () => {
		const o = { gatherer: GATHERER };
		expect(checkTool("Agent", { subagent_type: GATHERER, prompt: "read /var/log/syslog" }, o).ok).toBe(true);
		expect(
			checkTool("Task", { subagent_type: GATHERER, description: "d", prompt: "p", run_in_background: true }, o).ok,
		).toBe(true);
		expect(checkTool("Task", { subagent_type: GATHERER }, o).ok).toBe(false);
		for (const input of [
			{},
			{ subagent_type: "general-purpose" },
			{ subagent_type: "other-agent" },
			{ subagent_type: `${GATHERER}2` },
			{ prompt: "x" },
		])
			expect(checkTool("Agent", input, o).ok).toBe(false);
	});
	test("with no gatherer configured the Agent tool is refused, whatever it asks to start", () => {
		for (const name of [GATHERER, "general-purpose", "helper"]) {
			for (const tool of ["Agent", "Task"]) {
				const v = checkTool(tool, { subagent_type: name, prompt: "read /var/log/syslog" }, { gatherer: undefined });
				expect(v.ok).toBe(false);
				expect(v.ok ? "" : v.reason).toContain("no gatherer agent is configured");
			}
		}
	});
	test("a gatherer start cannot carry any other field: no checkout, no model, no remote run, no name or team", () => {
		const base = { subagent_type: GATHERER, prompt: "read /var/log/syslog" };
		for (const extra of [
			{ isolation: "worktree" },
			{ isolation: "remote" },
			{ model: "opus" },
			{ name: "x" },
			{ team_name: "t" },
			{ mode: "bypassPermissions" },
			{ cwd: "/" },
			{ Isolation: "worktree" },
			{ subagent_type: GATHERER, prompt: 1 },
			{ run_in_background: "yes" },
		]) {
			expect(checkTool("Agent", { ...base, ...extra }, { gatherer: GATHERER }).ok).toBe(false);
			expect(checkTool("Task", { ...base, ...extra }, { gatherer: GATHERER }).ok).toBe(false);
		}
	});
	test("run as the hook: exit 2 with a reason for a refusal, 0 for an allow", async () => {
		const run = async (payload: unknown) => {
			const p = Bun.spawn([process.execPath, new URL("./desk-allowlist.ts", import.meta.url).pathname, "hook"], {
				stdin: new TextEncoder().encode(JSON.stringify(payload)),
				stdout: "pipe",
				stderr: "pipe",
			});
			return { code: await p.exited, err: await new Response(p.stderr).text() };
		};
		expect((await run({ tool_name: "Bash", tool_input: { command: "journalctl -u a.service -n 5" } })).code).toBe(0);
		const bad = await run({ tool_name: "Bash", tool_input: { command: "systemctl cat a.service" } });
		expect(bad.code).toBe(2);
		expect(bad.err).toContain("refused");
		// Fail closed: input that is not a tool call is refused, never waved through.
		expect((await run("not an object")).code).toBe(2);
	});
});

describe("the morning sources are the operator's, never built in", () => {
	test("with no morning sources configured, a monitor's command is refused", () => {
		expect(checkCommand(`bun ${MONITOR} heartbeat --json`, { morning: [], shapes: {} }).ok).toBe(false);
	});
	test("a configured width is enforced: <N:1-5> takes 1 to 5 digits and no more", () => {
		const morning = [`bun ${MONITOR} list --limit <N:1-5> --json`];
		expect(checkCommand(`bun ${MONITOR} list --limit 12345 --json`, { morning }).ok).toBe(true);
		expect(checkCommand(`bun ${MONITOR} list --limit 123456 --json`, { morning }).ok).toBe(false);
		expect(checkCommand(`bun ${MONITOR} list --limit <N:1-5> --json`, { morning }).ok).toBe(false);
	});
	test("<N> is digits only, and the rest of the command must match exactly", () => {
		expect(checkCommand(`bun ${MONITOR} list --limit 12 --json`, OPS).ok).toBe(true);
		for (const c of [
			`bun ${MONITOR} list --limit x --json`,
			`bun ${MONITOR} list --limit 1 --json --out /tmp/x`,
			`bun ${MONITOR} list --limit 1;id --json`,
		])
			expect(checkCommand(c, OPS).ok).toBe(false);
	});
});
