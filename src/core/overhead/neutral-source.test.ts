import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

/**
 * The overhead monitor is a general Chamberlain feature, so no operator's name, repository, host, tool or model is built into its source or
 * its defaults: all of that is configuration (docs/CONFIGURATION.md, "overhead"). This scans the source, not the tests or the docs.
 */
const root = new URL("../..", import.meta.url).pathname;
const files = [
	...readdirSync(`${root}core/overhead`)
		.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
		.map((f) => `core/overhead/${f}`),
	"overhead.ts",
	"adapters/t3/investigator.ts",
];
const PERSONAL = /nbost|chamber-hero|chamberhero|spirit-media|memberhero|mithrandir|treehouse|\/home\/|~\/dev|carson/i;
const MODELS = /claude-(opus|sonnet|haiku|fable)|\b(opus|sonnet|haiku) ?5/i;

test("no operator-specific name or model is hard-coded in the overhead source", () => {
	expect(files.length).toBeGreaterThan(8);
	const hits: string[] = [];
	for (const f of files) {
		readFileSync(`${root}${f}`, "utf8")
			.split("\n")
			.forEach((line, i) => {
				if (PERSONAL.test(line) || MODELS.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
			});
	}
	expect(hits).toEqual([]);
});
