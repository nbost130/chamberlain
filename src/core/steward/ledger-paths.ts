/**
 * The ledger commands (`afk`, `decided`, `ruling`) live in src/core/ops/ (Chamberlain #79 moved them from src/core/).
 * The operator's decision-rights.md is their own words, verbatim, and may still name the old path. We never edit it; whatever
 * prints it (the hand-off, the wake, a synthetic wake) puts a note under each stale line with the path that exists.
 */

/** The ledger CLIs and where each one is, relative to a checkout. */
export const LEDGER_CLIS = ["afk", "decided", "ruling"] as const;
export const ledgerCliPath = (name: (typeof LEDGER_CLIS)[number]) => `src/core/ops/${name}.ts`;

/** A path ending in a ledger CLI under src/: `<prefix>src/<dirs>/<name>.ts`. */
const LEDGER_PATH = new RegExp(`([^\\s"'\`<>()]*?)src/((?:[\\w.-]+/)*)(${LEDGER_CLIS.join("|")})\\.ts`, "g");

export type StalePath = { stale: string; fixed: string };

/** Pure: the ledger CLI paths in `text` that are not under src/core/ops/, each with the path that exists. */
export function staleLedgerPaths(text: string): StalePath[] {
	const out: StalePath[] = [];
	for (const m of text.matchAll(LEDGER_PATH)) {
		const [stale, prefix = "", dirs = "", name = ""] = m;
		if (dirs === "core/ops/") continue;
		out.push({ stale, fixed: `${prefix}${ledgerCliPath(name as (typeof LEDGER_CLIS)[number])}` });
	}
	return out;
}

/**
 * Pure: `rights` with a note under every line that names a stale ledger CLI path. The line itself is untouched (it is the
 * operator's wording). The note is indented so it stays inside a markdown list item.
 */
export function withLedgerPathNotes(rights: string): string {
	if (!rights) return rights;
	return rights
		.split("\n")
		.flatMap((line) => {
			const stale = staleLedgerPaths(line);
			if (!stale.length) return [line];
			const fixes = stale.map((s) => `\`${s.stale}\` is now \`${s.fixed}\``).join("; ");
			return [
				line,
				`  (Chamberlain's note, not part of the operator's words: the ledger commands moved in Chamberlain #79. ${fixes}. Run the new path; a write to the old one goes to a dead ledger.)`,
			];
		})
		.join("\n");
}
