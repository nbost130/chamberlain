import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { base } from "../../testing/core-brief-fixtures.ts";
import { stewardBrief } from "./brief.ts";
import { LEDGER_CLIS, ledgerCliPath, staleLedgerPaths, withLedgerPathNotes } from "./ledger-paths.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const STALE_LINE =
	'- LOG every self-answer: bun ~/.local/share/chamberlain/app/src/core/decided.ts "<thread>" "<decision>" "<ruling>".';

/** Every `src/.../<ledger cli>.ts` path in `text`, as the repo-relative path. */
const ledgerPathsIn = (text: string) =>
	[...text.matchAll(new RegExp(`src/(?:[\\w.-]+/)*(?:${LEDGER_CLIS.join("|")})\\.ts`, "g"))].map((m) => m[0]);

describe("ledger CLI paths", () => {
	test("each ledger CLI exists where ledgerCliPath says", () => {
		for (const n of LEDGER_CLIS) expect(existsSync(join(ROOT, ledgerCliPath(n)))).toBe(true);
	});

	test("finds the pre-#79 paths, with a home prefix, and ignores the real ones", () => {
		expect(staleLedgerPaths(STALE_LINE)).toEqual([
			{
				stale: "~/.local/share/chamberlain/app/src/core/decided.ts",
				fixed: "~/.local/share/chamberlain/app/src/core/ops/decided.ts",
			},
		]);
		expect(
			staleLedgerPaths("bun src/core/afk.ts held; bun src/core/decide/decided.ts list").map((s) => s.fixed),
		).toEqual(["src/core/ops/afk.ts", "src/core/ops/decided.ts"]);
		expect(staleLedgerPaths("bun src/core/ops/ruling.ts list")).toEqual([]);
	});

	test("a note goes under the stale line, the line stays word for word, and clean text is returned as is", () => {
		const rights = `- DECIDE: x\n${STALE_LINE}\n- QUIET: y`;
		const out = withLedgerPathNotes(rights).split("\n");
		expect(out[1]).toBe(STALE_LINE);
		expect(out[2]).toContain("~/.local/share/chamberlain/app/src/core/ops/decided.ts");
		expect(out[2]?.startsWith("  (Chamberlain's note")).toBe(true);
		expect(out).toHaveLength(4);
		expect(withLedgerPathNotes("- DECIDE: x\n- QUIET: y")).toBe("- DECIDE: x\n- QUIET: y");
		expect(withLedgerPathNotes("")).toBe("");
	});

	test("the hand-off prints the operator's stale line verbatim, then a note naming the path that exists", () => {
		const b = stewardBrief({ ...base, rights: STALE_LINE });
		expect(b).toContain(`${STALE_LINE}\n  (Chamberlain's note`);
		expect(b).toContain("is now `~/.local/share/chamberlain/app/src/core/ops/decided.ts`");
	});

	test("a hand-off with no stale words names only ledger CLI paths that exist, and no note", () => {
		const b = stewardBrief(base);
		expect(b).not.toContain("Chamberlain's note");
		const paths = ledgerPathsIn(b);
		expect(paths.length).toBeGreaterThan(0);
		for (const p of paths) expect(existsSync(join(ROOT, p))).toBe(true);
	});
});

/** The two tests that hold a stale path on purpose, as the input they prove the note for. */
const FIXTURES = ["ledger-paths.test.ts", "engine.ledger-path-note.test.ts"];

/** The files whose text ships: everything in the checkout but dependencies, git and those fixtures. */
function shipped(dir = ""): string[] {
	return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
		const rel = join(dir, e.name);
		if (e.isDirectory()) return [".git", "node_modules", "coverage"].includes(e.name) ? [] : shipped(rel);
		return /\.(ts|js|md|json|yaml|yml|sh|service|timer|toml|txt)$/.test(e.name) &&
			!FIXTURES.some((x) => rel.endsWith(x))
			? [rel]
			: [];
	});
}

describe("shipped text", () => {
	test("no file names a ledger CLI path that does not exist", () => {
		const missing = shipped().flatMap((f) =>
			ledgerPathsIn(readFileSync(join(ROOT, f), "utf8"))
				.filter((p) => !existsSync(join(ROOT, p)))
				.map((p) => `${f}: ${p}`),
		);
		expect(missing).toEqual([]);
	});
});
