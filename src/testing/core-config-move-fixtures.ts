import { afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { readConfig } from "../core/alert-desk-config.ts";
import { migrateLayout } from "../core/config-migrate.ts";
import { cfg, readNamed, setting, thread } from "../core/layout.ts";
import { resetLayout } from "../core/layout-legacy.ts";
import { THREADS } from "../core/layout-schema.ts";
import { readServers } from "../core/servers.ts";
import { readSweepConfig } from "../core/sweep.ts";
import { loadConfig } from "../web/config.ts";
import { legacyFiles, writeLegacyConf } from "./legacy-conf.ts";

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useCoreConfigMoveFixtures() {
	const dirs: string[] = [];

	const fresh = () => {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-move-`);
		dirs.push(root);
		const conf = `${root}/conf`;
		mkdirSync(conf, { mode: 0o700 });
		return conf;
	};

	afterEach(() => {
		resetLayout();
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const NONE = {} as Record<string, string | undefined>;

	const SECRET_NAMES = Object.keys(legacyFiles()).filter((n) => /(^|-)(token|url)$/.test(n));

	/** Every value a reader returns, from whatever layout the directory is in now. */
	function snap(conf: string) {
		return {
			principal: setting("principal", conf, NONE),
			compact: setting("compactTokens", conf, NONE),
			servers: readServers(conf)?.map((s) => `${s.name}:${String(s.tokenFile)}`),
			web: loadConfig(conf).port,
			answerTokens: loadConfig(conf).answerTokens,
			sweep: readSweepConfig(conf).checks.map((c) => c.name),
			desk: readConfig(conf).dailyCap,
			rules: cfg(conf, "operatingRules"),
			threads: THREADS.map((m) => thread(conf, m)),
			secrets: Object.fromEntries(SECRET_NAMES.map((n) => [n, readNamed(conf, n)])),
			rights: readNamed(conf, "decision-rights.md"),
		};
	}

	const tree = (conf: string) =>
		[...readdirSync(conf), ...readdirSync(`${conf}/secrets`).map((n) => `secrets/${n}`)].sort();

	const treeSafe = (conf: string) => (existsSync(`${conf}/secrets`) ? tree(conf) : readdirSync(conf).sort());

	/** The steps one migration takes, in order: a dry list made by running it for real in a throwaway directory. */
	function stepsOf(): string[] {
		const conf = fresh();
		writeLegacyConf(conf);
		const steps: string[] = [];
		migrateLayout(conf, { afterStep: (s) => steps.push(s) });
		return steps;
	}

	return { fresh, NONE, SECRET_NAMES, snap, treeSafe, stepsOf };
}
