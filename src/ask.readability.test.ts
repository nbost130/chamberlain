import { expect, test } from "bun:test";
import { warnReadability } from "./ask-parse.ts";
import { questionStates } from "./core/items/questions.ts";
import { openStore } from "./core/store/sqlite-store.ts";
import { dbPath } from "./core/store/store.ts";
import { base, mk, refuses } from "./testing/ask-fixtures.ts";
import { useCoreMigrateFixtures } from "./testing/core-migrate-fixtures.ts";

const { world } = useCoreMigrateFixtures();
const RUN = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SHA = "1a2b3c4d5e6f";

test("ask stores only the canonical Details field, preserving the reference's whitespace", () => {
	const details = "  commit **literal**\n  path/to/file  ";
	expect(mk({ details }).details).toBe(details);
	const alias = mk({ technicalRef: details });
	expect(alias.details).toBe(details);
	expect(alias).not.toHaveProperty("technicalRef");
	expect(mk({})).not.toHaveProperty("details");
	expect(mk({ details: " " })).not.toHaveProperty("details");
	expect(mk({ details: "x".repeat(4000) }).details).toHaveLength(4000);
	refuses({ details: "", technicalRef: null }, "not both");
	refuses({ details: "x".repeat(4001) }, '"details" must be at most 4000 characters');
	refuses({ technicalRef: " ".repeat(4001) }, '"technicalRef" must be at most 4000 characters');
	refuses({ details: 12 }, '"details" must be a string');
	for (const secret of [{ secret: true }, { tag: " Secret " }]) {
		const input = { ...secret, options: [], threadId: "thread-1" };
		refuses({ ...input, details }, "a secret question cannot have details");
		refuses({ ...input, technicalRef: details }, "a secret question cannot have details");
	}
});

test("advisory warnings identify each readability problem, omit raw text, and still file the question", async () => {
	const { conf, state } = world();
	const title = `Review run ${RUN}`;
	const context = `- Commit ${SHA}\n- B\n- C\n- D\n- ${"x".repeat(161)}`;
	const technicalRef = "  audit reference\n  file path";
	const raw = { ...base, title, context, technicalRef, urgent: false };
	const p = Bun.spawn([process.execPath, new URL("./ask.ts", import.meta.url).pathname, JSON.stringify(raw)], {
		env: { ...process.env, CHAMBERLAIN_CONF: conf, CHAMBERLAIN_STATE: state },
		stderr: "pipe",
		stdout: "pipe",
	});
	const [err, out, code] = await Promise.all([new Response(p.stderr).text(), new Response(p.stdout).text(), p.exited]);
	expect(code).toBe(0);
	expect(out).toContain("not urgent: no notification sent");
	expect(err).toContain("title contains a raw run ID or long SHA");
	expect(err).toContain("context contains a raw run ID or long SHA");
	expect(err).toContain("context has more than 4 bullets");
	expect(err).toContain("bullet is longer than 160 characters");
	expect(err.match(/\bdetails\b/g)).toHaveLength(4);
	expect(err).not.toContain(RUN);
	expect(err).not.toContain(SHA);
	const store = openStore(dbPath(state));
	try {
		const filed = [...questionStates(store).values()][0];
		expect(filed).toMatchObject({ title, context, details: technicalRef });
		expect(filed).not.toHaveProperty("technicalRef");
	} finally {
		store.close();
	}
});

test("ordinary short bullets and references stay quiet, as do secret asks", () => {
	const warnings: string[] = [];
	const warn = (line: string) => warnings.push(line);
	for (const value of ["Q-abc12def", "PR #125 and issue 7", "2026-11-24", "ordinary prose", "defaced", "1a2b3c4"]) {
		warnReadability(mk({ title: value, context: `- ${value}`, details: `${RUN} ${SHA}` }), warn);
	}
	warnReadability(mk({ context: `- a\n- b\n- c\n- ${"x".repeat(160)}` }), warn);
	warnReadability(mk({ title: RUN, context: `- ${SHA}`, tag: "Secret", threadId: "thread-1", options: [] }), warn);
	expect(warnings).toEqual([]);
});
