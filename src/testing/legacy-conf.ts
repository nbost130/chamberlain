/**
 * An old-layout config directory made of fake values, for the migration test and for trying `chamberlain config migrate` by hand.
 *
 * It has exactly the file names of a real install of the old layout, with one server list of three servers (`main`, `mac`, `desktop`). The
 * values are made up: nothing here is, or is copied from, a real token, URL or thread id.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";

export const FAKE = {
	stewardThread: "fake-steward-thread-id",
	decisionsThread: "fake-decisions-thread-id",
	deskThread: "fake-desk-thread-id",
	wakeUrl: "https://fake.example/hooks/wake-0001",
	compactUrl: "https://fake.example/hooks/compact-0002",
	deskWakeUrl: "https://fake.example/hooks/desk-0003",
	tokens: {
		"main-token": "fake-read-token-main",
		"mac-token": "fake-read-token-mac",
		"desktop-token": "fake-read-token-desktop",
		"mac-operate-token": "fake-operate-token-mac",
		"desktop-operate-token": "fake-operate-token-desktop",
		"t3-operate-token": "fake-operate-token-t3",
	} as Record<string, string>,
};

export const SERVERS = {
	schemaVersion: 2,
	servers: [
		{ name: "main", adapter: "t3", origin: "http://127.0.0.1:3773", tokenFile: "main-token" },
		{
			name: "mac",
			adapter: "t3",
			origin: "http://127.0.0.1:3774",
			tokenFile: "mac-token",
			environmentId: "fake-env-mac",
			mayBeOffline: true,
			sshHost: "ada@mac.example",
		},
		{
			name: "desktop",
			adapter: "t3",
			origin: "http://127.0.0.1:3775",
			tokenFile: "desktop-token",
			environmentId: "fake-env-desktop",
		},
	],
};
export const SETTINGS = {
	schemaVersion: 2,
	principalName: "Ada",
	t3BaseDir: "~/fake-t3",
	alertCommand: "/fake/bin/alert",
	compactTokens: 123456,
	settledMatch: { titleOverlap: false, ignoreWords: ["acme"] },
};
export const WEB = {
	schemaVersion: 2,
	host: "127.0.0.1",
	port: 3790,
	allowedHosts: ["fake-host.example"],
	threadLinks: { main: "https://t3.example/threads/env/" },
	decisionsServer: { origin: "http://127.0.0.1:3773", operateTokenFile: "t3-operate-token" },
	answerTokens: { mac: "mac-operate-token", desktop: "desktop-operate-token" },
};
export const SWEEP = {
	schemaVersion: 2,
	checks: [{ name: "disk", command: ["/fake/check-disk.sh"], timeoutMs: 20000, mode: "live" }],
};
export const ALERT_DESK = {
	windowMinutes: 7,
	dailyCap: 9,
	morningHour: 6,
	morningCommands: ["fake-tool list --limit <N>"],
	morningNotes: "read the fake list",
	gatherer: "fake-gatherer",
};
export const OPERATING_RULES = {
	schemaVersion: 2,
	intro: "Fake intro.",
	sources: [{ path: "~/fake/RULES.md", sections: [["Secrets", "whole"]] }],
};
export const DAEMON_ENV =
	'# fake\nCHAMBERLAIN_RECOVER=1\nCHAMBERLAIN_ALERT_CMD=/fake/env/alert\nCHAMBERLAIN_REPORT_QUIET_MS="90000"\nPATH=/fake/bin\n';
export const DECISION_RIGHTS = "# Fake rights\n- Ask before anything irreversible.\n";

/** The twenty names of a live old-layout install, each with the value it holds. JSON files are given as objects. */
export function legacyFiles(): Record<string, string> {
	const j = (o: unknown) => `${JSON.stringify(o, null, 2)}\n`;
	return {
		"alert-desk.json": j(ALERT_DESK),
		"compact-url": `${FAKE.compactUrl}\n`,
		"daemon.env": DAEMON_ENV,
		"decision-rights.md": DECISION_RIGHTS,
		"decisions-thread": `${FAKE.decisionsThread}\n`,
		"desk-thread": `${FAKE.deskThread}\n`,
		"desk-wake-url": `${FAKE.deskWakeUrl}\n`,
		...Object.fromEntries(Object.entries(FAKE.tokens).map(([n, v]) => [n, `${v}\n`])),
		"operating-rules.json": j(OPERATING_RULES),
		"servers.json": j(SERVERS),
		"settings.json": j(SETTINGS),
		"steward-thread": `${FAKE.stewardThread}\n`,
		"sweep.json": j(SWEEP),
		"wake-url": `${FAKE.wakeUrl}\n`,
		"web.json": j(WEB),
	};
}

/** Writes `legacyFiles()` into `conf` (made 0700 if missing), every file 0600. Returns the names written. */
export function writeLegacyConf(conf: string): string[] {
	mkdirSync(conf, { recursive: true, mode: 0o700 });
	chmodSync(conf, 0o700);
	const files = legacyFiles();
	for (const [name, text] of Object.entries(files)) {
		writeFileSync(`${conf}/${name}`, text, { mode: 0o600 });
		chmodSync(`${conf}/${name}`, 0o600);
	}
	return Object.keys(files);
}
