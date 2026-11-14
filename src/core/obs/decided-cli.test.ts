/** `chamberlain decided` is a separate process: its ledger row and its event are two writes, and both land. */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { eventRows, THREAD } from "../../testing/obs.ts";
import { obsFor } from "../log.ts";
import { openStore } from "../sqlite-store.ts";
import { dbPath } from "../store.ts";

const SRC = new URL("..", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a decision logged by the CLI has its decision.logged event, keyed by the ledger id, with no text", async () => {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-decided-`);
	dirs.push(root);
	for (const d of ["conf", "state"]) mkdirSync(`${root}/${d}`, { mode: 0o700 });
	const run = Bun.spawn(
		["bun", `${SRC}decided.ts`, THREAD, "shipped the thing at https://example.com/x", "R12, R30: words"],
		{
			env: {
				...process.env,
				HOME: root,
				CHAMBERLAIN_CONF: `${root}/conf`,
				CHAMBERLAIN_STATE: `${root}/state`,
				CHAMBERLAIN_VERBOSE: "",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(await run.exited).toBe(0);
	const store = openStore(dbPath(`${root}/state`));
	try {
		const [row, ...more] = eventRows(obsFor(store));
		expect(more).toEqual([]);
		expect(row).toMatchObject({ event: "decision.logged", source_key: "decision:1", thread: THREAD, mod: "ledger" });
		expect(JSON.parse(row?.data ?? "{}")).toEqual({ cited: 2 });
		expect(JSON.stringify(row)).not.toContain("example.com");
	} finally {
		store.close();
	}
});
