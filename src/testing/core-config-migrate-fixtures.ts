import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resetLayout } from "../core/config/layout-legacy.ts";
import { tokensFor } from "./legacy-conf.ts";

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useCoreConfigMigrateFixtures() {
	const TOKENS = tokensFor();

	const dirs: string[] = [];

	const fresh = () => {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-confmig-`);
		dirs.push(root);
		const conf = `${root}/conf`;
		mkdirSync(conf, { mode: 0o700 });
		return conf;
	};

	afterEach(() => {
		resetLayout();
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const mode = (p: string) => statSync(p).mode & 0o777;

	const json = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;

	const NONE = {} as Record<string, string | undefined>;

	return { TOKENS, fresh, mode, json, NONE };
}
