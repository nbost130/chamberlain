/** The per-wake rights block carries the operator's words verbatim and, under a line naming a pre-#79 ledger path, the path that exists. */

import { describe, expect, test } from "bun:test";
import { useCoreEngineExtraFixtures } from "../../testing/core-engine-extra-fixtures.ts";
import { useCoreEngineFixtures } from "../../testing/core-engine-fixtures.ts";
import { createEngine } from "./engine.ts";

const { rig } = useCoreEngineFixtures(createEngine);
const { waitingOn } = useCoreEngineExtraFixtures(createEngine);

describe("wake rights text", () => {
	test("a stale ledger path in decision-rights.md gets a note with the real path under it, the line untouched", async () => {
		const r = rig({ steward: "steward-1" });
		const line = '- LOG every self-answer: bun ~/app/src/core/decided.ts "<thread>" "<decision>" "<ruling>".';
		r.priv("decision-rights.md", `- ASK: secrets\n${line}`);
		waitingOn(r, "t1", "req-1");
		await r.until("the wake", () => r.fake.wakes.length === 1);
		const m = r.fake.wakes[0]!.message;
		expect(m).toContain(`${line}\n  (Chamberlain's note`);
		expect(m).toContain("`~/app/src/core/decided.ts` is now `~/app/src/core/ops/decided.ts`");
	});
});
