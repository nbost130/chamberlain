import { afterEach } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useCoreMigrateFixtures() {
	const dirs: string[] = [];

	const world = () => {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-migrate-`);
		dirs.push(root);
		const conf = `${root}/conf`,
			state = `${root}/state`;
		mkdirSync(conf, { mode: 0o700 });
		mkdirSync(state, { mode: 0o700 });
		return { conf, state };
	};

	const put = (path: string, text: string) => {
		writeFileSync(path, text, { mode: 0o600 });
		chmodSync(path, 0o600);
	};

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	/** Config files written by hand: none carries a schemaVersion. */
	function oldInstall(w: { conf: string; state: string }) {
		put(
			`${w.conf}/servers.json`,
			JSON.stringify({ servers: [{ name: "main", origin: "http://127.0.0.1:3773", tokenFile: "read-token" }] }),
		);
		put(`${w.conf}/web.json`, JSON.stringify({ host: "127.0.0.1", port: 3790 }));
		put(`${w.conf}/settings.json`, JSON.stringify({ principalName: "Ada" }));
		put(`${w.conf}/sweep.json`, JSON.stringify({ checks: [] }));
	}

	return { world, put, oldInstall };
}
