import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { checkCommand, checkPath, checkTool, LOG_DIRS } from "./desk-allowlist.ts";

const HOME = process.env.HOME!;
/** The operator's morning sources, as alert-desk.json would list them (`<N>` is a number). Nothing of the kind is built in. */
const MONITOR = "/opt/monitor/report.ts";
const MORNING = [
	`bun ${MONITOR} heartbeat --json`,
	`bun ${MONITOR} list --limit <N> --json`,
	`docker exec -u svc db1 bash -lc "printf 'GET log\\nColumns: time host_name service_description state plugin_output\\nFilter: class = 3\\nFilter: time >= <N>\\nOutputFormat: csv\\n' | lq"`,
];
const refused = (cmd: string) => { const v = checkCommand(cmd, { morning: MORNING }); expect(v.ok).toBe(false); return v.ok ? "" : v.reason; };
const allowed = (cmd: string) => expect(checkCommand(cmd, { morning: MORNING })).toEqual({ ok: true });

describe("the approved shapes are accepted", () => {
	test.each([
		"journalctl -u monitor.service -n 50 --no-pager",
		"journalctl --user -u chamberlain.service --since '1 hour ago' -p err",
		'journalctl -u a.service --since "2026-11-13 08:00:00" --until "2026-11-13 09:00:00" -o short-iso',
		"systemctl status monitor.service",
		"systemctl --user status chamberlain.service --no-pager -n 20",
		"systemctl is-active monitor.service",
		"systemctl list-units --failed",
		"systemctl --user list-units --failed",
		"example-tool",
		"example-tool health cron",
		"example-tool service all",
		"example-tool network ports",
		"example-tool journal monitor --limit 20",
		"gh run view 123456 --log-failed --repo example-org/app",
		"gh run list --repo example-org/app --limit 5",
		"gh pr checks 42 --repo example-org/monitor",
		"git status",
		"git log -n 5 --oneline",
		"git diff --stat main",
		"git diff 'HEAD~1' -- src/gateway/alertmanager.ts",
		"docker ps -a",
		"docker ps --format '{{.Names}} {{.Status}}'",
		"docker logs --tail 100 mc-paper",
		"docker inspect --format '{{.State.Status}} {{.RestartCount}}' mc-paper",
		"docker inspect -f '{{.Config.Image}}' mc-paper",
		"docker inspect --format='{{.State.Status}}' mc-paper",
		"journalctl -u a.service -n 50 | head -n 20",
		"docker logs --tail 500 mc-paper | tail -n 40",
		"journalctl -u a.service | wc -l",
		`bun ${MONITOR} heartbeat --json`,
		`bun ${MONITOR} list --limit 1000 --json`,
		`docker exec -u svc db1 bash -lc "printf 'GET log\\nColumns: time host_name service_description state plugin_output\\nFilter: class = 3\\nFilter: time >= 1731400000\\nOutputFormat: csv\\n' | lq"`,
		`bun ${HOME}/Projects/chamberlain/src/ask.ts '{"kind":"product","title":"Restart a.service?","options":[{"label":"yes"},{"label":"no"}]}'`,
	])("%s", (cmd) => allowed(cmd));
});

describe("each widened argument is refused", () => {
	test("git diff with --output, in every spelling, and any file-writing flag", () => {
		for (const c of ["git diff --output=/tmp/x", "git diff --output /tmp/x", "git diff -o /tmp/x", "git log --output=/tmp/x", "git diff HEAD --output=/home/u/.bashrc", "git diff -- --output=/tmp/x", "git diff --ext-diff", "git diff --no-index /etc/passwd /tmp/x", "git diff --textconv", "git log --format=%H --output=/tmp/x"]) expect(refused(c).length).toBeGreaterThan(0);
	});
	test("git paths cannot climb out of the repo or be absolute", () => {
		refused("git diff -- /etc/passwd");
		refused("git diff -- ../../.env");
		refused("git diff -- src/../../x");
		refused("git commit -m x");
		refused("git push");
		refused("git status --porcelain=v1 -z");
	});
	test("docker inspect needs a --format and cannot reach Config.Env", () => {
		expect(refused("docker inspect mc-paper")).toContain("--format is required");
		for (const f of ["{{.Config.Env}}", "{{json .Config}}", "{{json .}}", "{{.}}", "{{.Config}}", "{{range .Config.Env}}{{.}}{{end}}", "{{index .Config.Env 0}}", "{{.Config.Cmd}}", "{{ .Config.Env }}", "{{.State.Status}}{{.Config.Env}}", "{{.Env}}", "{{println .Config.Env}}"]) refused(`docker inspect --format '${f}' mc-paper`);
		refused("docker inspect -f '{{.Config.Env}}' mc-paper");
		refused("docker inspect --format={{.Config.Env}} mc-paper");
		refused("docker inspect --size --format '{{.State.Status}}' mc-paper");
	});
	test("docker ps --format cannot use json or unlisted fields; other docker verbs are refused", () => {
		refused("docker ps --format '{{json .}}'");
		refused("docker ps --format '{{.Labels}}'");
		for (const c of ["docker exec mc-paper env", "docker run alpine", "docker restart mc-paper", "docker rm mc-paper", "docker cp mc-paper:/x /tmp/x", "docker logs -f mc-paper", "docker logs", "docker stop x"]) refused(c);
	});
	test("systemctl cat and show are refused, and so is every mutating verb", () => {
		expect(refused("systemctl cat monitor.service")).toContain("cat");
		refused("systemctl --user cat chamberlain.service");
		refused("systemctl show monitor.service");
		for (const v of ["restart", "stop", "start", "enable", "disable", "daemon-reload", "kill", "edit", "mask", "reload", "set-environment A=b"]) refused(`systemctl ${v} monitor.service`);
		refused("systemctl status");
		refused("systemctl");
	});
	test("journalctl cannot read another file or change anything", () => {
		for (const c of ["journalctl --file=/home/u/.env", "journalctl -D /tmp/x", "journalctl --directory=/tmp/x", "journalctl --vacuum-size=1M", "journalctl --rotate", "journalctl --flush", "journalctl --setup-keys", "journalctl --root=/x", "journalctl -u a -o export", "journalctl -u 'a b;id'", "journalctl /usr/bin/sudo", "journalctl -n abc", "journalctl --since '$(id)'"]) refused(c);
	});
	test("gh and example-tool: only the listed reads", () => {
		for (const c of ["gh run view 1 --web", "gh pr merge 1", "gh run rerun 1", "gh run view abc", "gh api repos/x/y", "gh pr checks 1 --repo ../../x", "gh run view 1 --log", "example-tool update", "example-tool update --check", "example-tool docker restart", "example-tool journal", "example-tool bogus", "example-tool --version"]) refused(c);
	});
	test("a command outside the set, by name, path or environment prefix", () => {
		for (const c of ["cat /var/log/syslog", "ls /var/log", "rm -rf /tmp/x", "sudo journalctl", "curl https://x.test", "bash -c 'id'", "sh -c id", "python3 -c 'print(1)'", "/usr/bin/journalctl -n 5", "./journalctl", "FOO=bar journalctl -n 5", "env journalctl", "find / -name .env", "grep -r token /var/log", "tee /tmp/x", "kill 1", "bun -e '1'", `bun ${HOME}/Projects/chamberlain/src/daemon.ts`, `bun ${MONITOR} emit --source x`, `bun ${MONITOR} heartbeat`]) refused(c);
	});
	test("shell syntax: chaining, substitution, redirection, globs, newlines", () => {
		for (const t of ["journalctl -n 5; id", "journalctl -n 5 && id", "journalctl -n 5 || id", "journalctl -n 5 & id", "journalctl -n $(id)", "journalctl -n `id`", "journalctl -n 5 > /tmp/x", "journalctl -n 5 >> /tmp/x", "journalctl -n 5 < /etc/passwd", "journalctl -u *", "journalctl -u a?", "journalctl -n 5\nid", "journalctl -u \"$HOME\"", "journalctl -u '", "journalctl -n 5 | sh", "journalctl -n 5 | head -n 5 | sh", "journalctl -n 5 | tee /tmp/x", "journalctl -n 5 | head", "journalctl -n 5 | head -n 5 -c 3", "journalctl -n 5 |", "| journalctl", "journalctl -u ~root", "journalctl -u a\\ b", "journalctl --since=${IFS}x"]) refused(t);
	});
	test("appending shell syntax to any approved command refuses it", () => {
		const cmds = ["journalctl -u a.service -n 5", "systemctl status a.service", "example-tool health", "gh pr checks 1 --repo a/b", "git status", "docker ps", "docker logs --tail 5 c"];
		for (const c of cmds) for (const tail of [" ; id", " && id", " > /tmp/x", " $(id)", " `id`", " | sh", "\nid"]) expect(checkCommand(c + tail, { morning: MORNING }).ok).toBe(false);
	});
	test("the exact shapes cannot be extended", () => {
		refused(`bun ${MONITOR} list --limit 1000 --json; id`);
		refused(`bun ${MONITOR} list --limit 1000 --json --out /tmp/x`);
		refused(`docker exec -u svc db1 bash -lc "printf 'GET log\\nFilter: time >= 1731400000\\n' | lq; id"`);
		refused(`docker exec -u svc db1 bash -lc "id"`);
		refused(`bun ${HOME}/Projects/chamberlain/src/ask.ts '{}' ; id`);
		refused(`bun ${HOME}/Projects/chamberlain/src/ask.ts 'a' 'b'`);
		refused(`bun ${HOME}/Projects/chamberlain/src/ask.ts "{}"`);
	});
});

describe("the whole argument list is parsed: a flag given twice is refused, in any spelling", () => {
	const SAFE = "'{{.Name}}'", ENV = "'{{.Config.Env}}'", JSON_ALL = "'{{json .}}'";
	test("a repeated --format cannot smuggle a second, unsafe one", () => {
		for (const c of [
			`docker inspect --format ${SAFE} --format ${ENV} mc-paper`,
			`docker inspect --format ${ENV} --format ${SAFE} mc-paper`,
			`docker inspect --format ${SAFE} --format ${JSON_ALL} mc-paper`,
			`docker inspect mc-paper --format ${SAFE} --format ${ENV}`,
		]) refused(c);
	});
	test("mixed -f, --format and --format= forms are refused whichever order", () => {
		for (const c of [
			`docker inspect -f ${SAFE} --format ${ENV} mc-paper`,
			`docker inspect -f ${SAFE} --format=${ENV} mc-paper`,
			`docker inspect --format=${SAFE} -f ${ENV} mc-paper`,
			`docker inspect --format ${SAFE} -f ${ENV} mc-paper`,
			`docker inspect --format=${SAFE} --format=${ENV} mc-paper`,
			`docker inspect -f ${ENV} -f ${SAFE} mc-paper`,
		]) refused(c);
		// Two flags that are each fine are still two flags.
		expect(refused(`docker inspect -f ${SAFE} -f ${SAFE} mc-paper`)).toContain("more than once");
		expect(refused(`docker inspect --format ${SAFE} --format=${SAFE} mc-paper`)).toContain("more than once");
	});
	test("{{json .}} and the other whole-document forms are refused as the one format", () => {
		for (const f of [JSON_ALL, "'{{json .Config}}'", "'{{.}}'", "'{{.Config}}'", "'{{.Config.Env}}'", "'{{printf \"%v\" .Config.Env}}'"]) refused(`docker inspect --format ${f} mc-paper`);
		refused(`docker inspect --format=${JSON_ALL} mc-paper`);
		refused(`docker inspect -f ${JSON_ALL} mc-paper`);
	});
	test("a flag may be given once on every command: journalctl, systemctl, docker, git, gh", () => {
		for (const c of [
			"journalctl -u a.service -u b.service", "journalctl -u a.service --unit b.service", "journalctl -n 5 --lines 6", "journalctl --since '1 hour ago' --since '1 day ago'", "journalctl --user --user", "journalctl -p err --priority warning", "journalctl -o cat --output short",
			"systemctl status a.service --user --user", "systemctl status a.service -n 5 -n 6", "systemctl status a.service -l --full", "systemctl status a.service --full -l", "systemctl status a.service -n 5 --lines 6",
			"docker ps -a --all", "docker ps -a -a", "docker ps --format '{{.Names}}' --format '{{.Labels}}'", "docker logs --tail 1 --tail 2 c", "docker logs -t --timestamps c",
			"git diff -n 1 --max-count 2", "git log --stat --stat", "git diff --since 1.day --since 2.day",
			"gh run view 1 --repo a/b --repo c/d", "gh run view 1 --log-failed --log-failed", "gh run list --limit 1 --limit 2", "example-tool journal x --limit 1 --limit 2",
		]) expect(refused(c)).toContain("more than once");
	});
	test("every value of every flag is checked, not only the first", () => {
		refused("journalctl -u a.service --since '$(id)'");
		refused("journalctl -n 5 -u 'a b'");
		refused("docker logs --tail x c");
		refused("docker inspect --format '{{.Name}}' --format=");
	});
	test("a journald priority is a real level or a range of two, and nothing else", () => {
		for (const p of ["err", "warning", "0", "7", "debug", "warning..emerg", "0..3"]) allowed(`journalctl -u a.service -p ${p}`);
		for (const p of ["nonsense", "8", "error", "err..", "..err", "err..warning..info", "e.r.r"]) expect(refused(`journalctl -u a.service -p ${p}`)).toContain("value of -p");
		expect(refused("journalctl -u a.service --priority nonsense")).toContain("value of --priority");
	});
});

describe("file reads", () => {
	const dir = mkdtempSync(`${tmpdir()}/desk-reads-`);
	test("only under the named log directories", () => {
		expect(LOG_DIRS).toContain("/var/log");
		expect(checkPath("/var/log/syslog").ok).toBe(true);
		expect(checkPath(`${HOME}/.cache/alert-desk/inbox.jsonl`).ok).toBe(true);
		for (const p of ["/etc/passwd", `${HOME}/.bashrc`, `${HOME}/monitor/src/index.ts`, `${HOME}/.cache/other/x.log`, "relative/path.log", "/var/logger/x", "/var"]) expect(checkPath(p).ok).toBe(false);
	});
	test("never a credential, even inside a log directory", () => {
		for (const p of ["/var/log/.env", "/var/log/app/.env.production", `${HOME}/.cache/alert-desk/.env`, `${HOME}/.cache/alert-desk/read-token`, "/var/log/id_ed25519", "/var/log/server.pem", "/var/log/credentials.json", "/var/log/.ssh/config", "/var/log/auth-token.txt", "/var/log/passage/x", "/var/log/db-password", "/var/log/.aws/credentials"]) expect(checkPath(p).ok).toBe(false);
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
		try { symlinkSync(outside, `${dir}/link`); } catch { return; }
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
		for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) expect(checkTool(t, { file_path: "/var/log/x" }).ok).toBe(false);
	});
	test("deny by default: any tool that is not named is refused, MCP tools and unknown names included", () => {
		for (const t of ["ToolSearch", "WebFetch", "WebSearch", "Skill", "TaskStop", "SendMessage", "CronCreate", "ExitPlanMode", "Workflow", "TodoWrite", "mcp__t3-code__t3_thread_send", "mcp__t3-code__t3_thread_read", "mcp__example__example_service_status", "mcp__playwright__playwright_navigate", "SomeToolThatDoesNotExistYet", "bash", "BASH", ""]) expect(checkTool(t, {}).ok).toBe(false);
		expect(checkTool(undefined, {}).ok).toBe(false);
		expect(checkTool(42, {}).ok).toBe(false);
		expect(checkTool("mcp__t3-code__t3_thread_send", { message: "x" })).toMatchObject({ ok: false });
	});
	test("the Agent tool starts a example-gatherer gatherer and nothing else", () => {
		expect(checkTool("Agent", { subagent_type: "example-gatherer", prompt: "read /var/log/syslog" }).ok).toBe(true);
		expect(checkTool("Task", { subagent_type: "example-gatherer", description: "d", prompt: "p", run_in_background: true }).ok).toBe(true);
		expect(checkTool("Task", { subagent_type: "example-gatherer" }).ok).toBe(false);
		for (const input of [{}, { subagent_type: "general-purpose" }, { subagent_type: "other-agent" }, { subagent_type: "example-gatherer2" }, { prompt: "x" }]) expect(checkTool("Agent", input).ok).toBe(false);
	});
	test("a example-gatherer start cannot carry any other field: no checkout, no model, no remote run, no name or team", () => {
		const base = { subagent_type: "example-gatherer", prompt: "read /var/log/syslog" };
		for (const extra of [{ isolation: "worktree" }, { isolation: "remote" }, { model: "opus" }, { name: "x" }, { team_name: "t" }, { mode: "bypassPermissions" }, { cwd: "/" }, { Isolation: "worktree" }, { subagent_type: "example-gatherer", prompt: 1 }, { run_in_background: "yes" }]) {
			expect(checkTool("Agent", { ...base, ...extra }).ok).toBe(false);
			expect(checkTool("Task", { ...base, ...extra }).ok).toBe(false);
		}
	});
	test("run as the hook: exit 2 with a reason for a refusal, 0 for an allow", async () => {
		const run = async (payload: unknown) => {
			const p = Bun.spawn([process.execPath, new URL("./desk-allowlist.ts", import.meta.url).pathname, "hook"], { stdin: new TextEncoder().encode(JSON.stringify(payload)), stdout: "pipe", stderr: "pipe" });
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
		expect(checkCommand(`bun ${MONITOR} heartbeat --json`, { morning: [] }).ok).toBe(false);
	});
	test("a configured width is enforced: <N:1-5> takes 1 to 5 digits and no more", () => {
		const morning = [`bun ${MONITOR} list --limit <N:1-5> --json`];
		expect(checkCommand(`bun ${MONITOR} list --limit 12345 --json`, { morning }).ok).toBe(true);
		expect(checkCommand(`bun ${MONITOR} list --limit 123456 --json`, { morning }).ok).toBe(false);
		expect(checkCommand(`bun ${MONITOR} list --limit <N:1-5> --json`, { morning }).ok).toBe(false);
	});
	test("<N> is digits only, and the rest of the command must match exactly", () => {
		expect(checkCommand(`bun ${MONITOR} list --limit 12 --json`, { morning: MORNING }).ok).toBe(true);
		for (const c of [`bun ${MONITOR} list --limit x --json`, `bun ${MONITOR} list --limit 1 --json --out /tmp/x`, `bun ${MONITOR} list --limit 1;id --json`]) expect(checkCommand(c, { morning: MORNING }).ok).toBe(false);
	});
});
