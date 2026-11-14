/**
 * The settings.json shape: the five settings the first Chamberlain kept in one small file, now the `principal`, `t3Dir`, `t3StateDb`, `alertCmd`,
 * `compactTokens` and `settledMatch` keys of config.json (src/core/layout.ts). This module only parses and checks the OLD file, so the
 * layout code can read it without importing config.ts (which imports the layout).
 */
import { SCHEMA_VERSION, checkVersion } from "./schema.ts";

export type Settings = {
	schemaVersion?: number;
	/** What the Steward's wakes and hand-off call the human it works for: "Ada", "the operator". */
	principalName?: string;
	/** The T3 adapter's: T3's base directory. Default ~/.t3. */
	t3BaseDir?: string;
	/** The T3 adapter's: T3's state database. Default <t3BaseDir>/userdata/statev2.sqlite. */
	t3StateDb?: string;
	/** A command run for each alarm as `<command> <severity> <title> <summary>`. Without one, alarms are only logged. */
	alertCommand?: string;
	/** The Steward's context size, in tokens, past which the daemon sends a compact. Default 350000. */
	compactTokens?: number;
	/** How ask.ts and `afk.ts hold` decide a question is already settled (src/core/settled.ts). */
	settledMatch?: SettledMatch;
};
/**
 * The settled check's one tunable rule. `titleOverlap: false` matches on exact refs only (a commit, a run, an item, or a PR,
 * branch or thread beside the same topic). `ignoreWords` are words that head many unrelated questions in your setup (a
 * project or product name), so sharing one says nothing about the topic.
 */
export type SettledMatch = { titleOverlap?: boolean; ignoreWords?: string[] };

/**
 * Pure: a `settledMatch` value checked and normalised, or the first thing wrong with it. `where` names the file in the message: the one check
 * serves settings.json and the `settledMatch` key of config.json.
 */
export function parseSettledMatch(sm: unknown, where: string): SettledMatch {
	if (sm === null || typeof sm !== "object" || Array.isArray(sm))
		throw Error(`${where}: "settledMatch" must be an object`);
	const { titleOverlap, ignoreWords, ...extra } = sm as Record<string, unknown>;
	if (Object.keys(extra).length)
		throw Error(`${where}: "settledMatch" has unknown keys: ${Object.keys(extra).join(", ")}`);
	if (titleOverlap !== undefined && typeof titleOverlap !== "boolean")
		throw Error(`${where}: "settledMatch.titleOverlap" must be true or false`);
	if (
		ignoreWords !== undefined &&
		(!Array.isArray(ignoreWords) || ignoreWords.some((w) => typeof w !== "string" || !w.trim()))
	)
		throw Error(`${where}: "settledMatch.ignoreWords" must be a list of words`);
	return {
		...(titleOverlap !== undefined ? { titleOverlap } : {}),
		...(ignoreWords !== undefined ? { ignoreWords: (ignoreWords as string[]).map((w) => w.trim()) } : {}),
	};
}

/** Pure: the settings a parsed file holds, or the first thing wrong with it. */
export function parseSettings(raw: unknown): Settings {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw))
		throw Error("settings.json: expected a JSON object");
	const o = raw as Record<string, unknown>;
	checkVersion("settings.json", o.schemaVersion);
	const str = (k: string) => {
		const v = o[k];
		if (v === undefined) return undefined;
		if (typeof v !== "string" || !v.trim()) throw Error(`settings.json: "${k}" must be a non-empty string`);
		return v.trim();
	};
	const compactTokens = o.compactTokens;
	if (
		compactTokens !== undefined &&
		(typeof compactTokens !== "number" || !Number.isFinite(compactTokens) || compactTokens <= 0)
	)
		throw Error('settings.json: "compactTokens" must be a positive number');
	const settledMatch = o.settledMatch === undefined ? undefined : parseSettledMatch(o.settledMatch, "settings.json");
	return {
		schemaVersion: SCHEMA_VERSION,
		...(str("principalName") ? { principalName: str("principalName") } : {}),
		...(str("t3BaseDir") ? { t3BaseDir: str("t3BaseDir") } : {}),
		...(str("t3StateDb") ? { t3StateDb: str("t3StateDb") } : {}),
		...(str("alertCommand") ? { alertCommand: str("alertCommand") } : {}),
		...(compactTokens !== undefined ? { compactTokens: compactTokens as number } : {}),
		...(settledMatch ? { settledMatch } : {}),
	};
}
