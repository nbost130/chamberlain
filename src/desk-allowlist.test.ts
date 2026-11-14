import { describe, expect, test } from "bun:test";
import { checkCommand } from "./desk-allowlist.ts";
import { ASK, allowed, HOME, MONITOR, OPS, refused } from "./testing/desk-allowlist-fixtures.ts";

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
		"opsctl",
		"opsctl health cron",
		"opsctl service all",
		"opsctl network ports",
		"opsctl journal monitor --limit 20",
		"gh run view 123456 --log-failed --repo example-org/app",
		"gh run list --repo example-org/app --limit 5",
		"gh pr checks 42 --repo example-org/monitor",
		"git status",
		"git log -n 5 --oneline",
		"git diff --stat main",
		"git diff 'HEAD~1' -- src/gateway/alertmanager.ts",
		"docker ps -a",
		"docker ps --format '{{.Names}} {{.Status}}'",
		"docker logs --tail 100 web-app",
		"docker inspect --format '{{.State.Status}} {{.RestartCount}}' web-app",
		"docker inspect -f '{{.Config.Image}}' web-app",
		"docker inspect --format='{{.State.Status}}' web-app",
		"journalctl -u a.service -n 50 | head -n 20",
		"docker logs --tail 500 web-app | tail -n 40",
		"journalctl -u a.service | wc -l",
		`bun ${MONITOR} heartbeat --json`,
		`bun ${MONITOR} list --limit 1000 --json`,
		`docker exec -u svc db1 sh -lc "printf 'SELECT time, host, state FROM events WHERE time >= 1731400000\\n' | query"`,
		`${ASK} '{"kind":"product","title":"Restart a.service?","options":[{"label":"yes"},{"label":"no"}]}'`,
	])("%s", (cmd) => allowed(cmd));
});

describe("each widened argument is refused", () => {
	test("git diff with --output, in every spelling, and any file-writing flag", () => {
		for (const c of [
			"git diff --output=/tmp/x",
			"git diff --output /tmp/x",
			"git diff -o /tmp/x",
			"git log --output=/tmp/x",
			"git diff HEAD --output=/home/u/.bashrc",
			"git diff -- --output=/tmp/x",
			"git diff --ext-diff",
			"git diff --no-index /etc/passwd /tmp/x",
			"git diff --textconv",
			"git log --format=%H --output=/tmp/x",
		])
			expect(refused(c).length).toBeGreaterThan(0);
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
		expect(refused("docker inspect web-app")).toContain("--format is required");
		for (const f of [
			"{{.Config.Env}}",
			"{{json .Config}}",
			"{{json .}}",
			"{{.}}",
			"{{.Config}}",
			"{{range .Config.Env}}{{.}}{{end}}",
			"{{index .Config.Env 0}}",
			"{{.Config.Cmd}}",
			"{{ .Config.Env }}",
			"{{.State.Status}}{{.Config.Env}}",
			"{{.Env}}",
			"{{println .Config.Env}}",
		])
			refused(`docker inspect --format '${f}' web-app`);
		refused("docker inspect -f '{{.Config.Env}}' web-app");
		refused("docker inspect --format={{.Config.Env}} web-app");
		refused("docker inspect --size --format '{{.State.Status}}' web-app");
	});
	test("docker ps --format cannot use json or unlisted fields; other docker verbs are refused", () => {
		refused("docker ps --format '{{json .}}'");
		refused("docker ps --format '{{.Labels}}'");
		for (const c of [
			"docker exec web-app env",
			"docker run alpine",
			"docker restart web-app",
			"docker rm web-app",
			"docker cp web-app:/x /tmp/x",
			"docker logs -f web-app",
			"docker logs",
			"docker stop x",
		])
			refused(c);
	});
	test("systemctl cat and show are refused, and so is every mutating verb", () => {
		expect(refused("systemctl cat monitor.service")).toContain("cat");
		refused("systemctl --user cat chamberlain.service");
		refused("systemctl show monitor.service");
		for (const v of [
			"restart",
			"stop",
			"start",
			"enable",
			"disable",
			"daemon-reload",
			"kill",
			"edit",
			"mask",
			"reload",
			"set-environment A=b",
		])
			refused(`systemctl ${v} monitor.service`);
		refused("systemctl status");
		refused("systemctl");
	});
	test("journalctl cannot read another file or change anything", () => {
		for (const c of [
			"journalctl --file=/home/u/.env",
			"journalctl -D /tmp/x",
			"journalctl --directory=/tmp/x",
			"journalctl --vacuum-size=1M",
			"journalctl --rotate",
			"journalctl --flush",
			"journalctl --setup-keys",
			"journalctl --root=/x",
			"journalctl -u a -o export",
			"journalctl -u 'a b;id'",
			"journalctl /usr/bin/sudo",
			"journalctl -n abc",
			"journalctl --since '$(id)'",
		])
			refused(c);
	});
	test("gh and opsctl: only the listed reads", () => {
		for (const c of [
			"gh run view 1 --web",
			"gh pr merge 1",
			"gh run rerun 1",
			"gh run view abc",
			"gh api repos/x/y",
			"gh pr checks 1 --repo ../../x",
			"gh run view 1 --log",
			"opsctl update",
			"opsctl update --check",
			"opsctl docker restart",
			"opsctl journal",
			"opsctl bogus",
			"opsctl --version",
		])
			refused(c);
	});
	test("a command outside the set, by name, path or environment prefix", () => {
		for (const c of [
			"cat /var/log/syslog",
			"ls /var/log",
			"rm -rf /tmp/x",
			"sudo journalctl",
			"curl https://x.test",
			"bash -c 'id'",
			"sh -c id",
			"python3 -c 'print(1)'",
			"/usr/bin/journalctl -n 5",
			"./journalctl",
			"FOO=bar journalctl -n 5",
			"env journalctl",
			"find / -name .env",
			"grep -r token /var/log",
			"tee /tmp/x",
			"kill 1",
			"bun -e '1'",
			`bun ${HOME}/Projects/chamberlain/src/daemon.ts`,
			`bun ${MONITOR} emit --source x`,
			`bun ${MONITOR} heartbeat`,
		])
			refused(c);
	});
	test("shell syntax: chaining, substitution, redirection, globs, newlines", () => {
		for (const t of [
			"journalctl -n 5; id",
			"journalctl -n 5 && id",
			"journalctl -n 5 || id",
			"journalctl -n 5 & id",
			"journalctl -n $(id)",
			"journalctl -n `id`",
			"journalctl -n 5 > /tmp/x",
			"journalctl -n 5 >> /tmp/x",
			"journalctl -n 5 < /etc/passwd",
			"journalctl -u *",
			"journalctl -u a?",
			"journalctl -n 5\nid",
			'journalctl -u "$HOME"',
			"journalctl -u '",
			"journalctl -n 5 | sh",
			"journalctl -n 5 | head -n 5 | sh",
			"journalctl -n 5 | tee /tmp/x",
			"journalctl -n 5 | head",
			"journalctl -n 5 | head -n 5 -c 3",
			"journalctl -n 5 |",
			"| journalctl",
			"journalctl -u ~root",
			"journalctl -u a\\ b",
			`journalctl --since=\${IFS}x`,
		])
			refused(t);
	});
	test("appending shell syntax to any approved command refuses it", () => {
		const cmds = [
			"journalctl -u a.service -n 5",
			"systemctl status a.service",
			"opsctl health",
			"gh pr checks 1 --repo a/b",
			"git status",
			"docker ps",
			"docker logs --tail 5 c",
		];
		for (const c of cmds)
			for (const tail of [" ; id", " && id", " > /tmp/x", " $(id)", " `id`", " | sh", "\nid"])
				expect(checkCommand(c + tail, OPS).ok).toBe(false);
	});
	test("the exact shapes cannot be extended", () => {
		refused(`bun ${MONITOR} list --limit 1000 --json; id`);
		refused(`bun ${MONITOR} list --limit 1000 --json --out /tmp/x`);
		refused(`docker exec -u svc db1 sh -lc "printf 'SELECT time FROM events WHERE time >= 1731400000\\n' | query; id"`);
		refused(`docker exec -u svc db1 sh -lc "id"`);
		refused(`${ASK} '{}' ; id`);
		refused(`${ASK} 'a' 'b'`);
		refused(`${ASK} "{}"`);
	});
});
