/** Reading config.json. */
import { lstatSync, readFileSync } from "node:fs";
import { CONFIG_FILE, ConfigFileError, DEFAULT_CONF, parseConfigDoc } from "./layout-schema.ts";
import { authorityProblem } from "./private.ts";

/** The parsed config.json, or undefined when there is none. The file must be the operator's alone to write (not group- or world-writable). */
export function readConfigFile(conf = DEFAULT_CONF): Record<string, unknown> | undefined {
	const p = `${conf}/${CONFIG_FILE}`;
	let text: string;
	try {
		const bad = authorityProblem(lstatSync(p), "file");
		if (bad) throw new ConfigFileError(`${p}: ${bad}. It names commands the daemon runs: chmod 600 it first.`);
		text = readFileSync(p, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw e;
	}
	try {
		return parseConfigDoc(JSON.parse(text));
	} catch (e) {
		if (e instanceof SyntaxError) throw new ConfigFileError(`${p} is not valid JSON: ${e.message}`);
		throw e;
	}
}
