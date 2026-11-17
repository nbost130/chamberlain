import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { mailConfig } from "./model-config.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("all mail roles honor central selection and retain explicit consent", () => {
	const conf = mkdtempSync(`${tmpdir()}/mail-models-`);
	dirs.push(conf);
	for (const role of ["mailDriver", "mailEscalate", "mailTop"]) {
		for (const adapter of ["claude-cli", "openai-chat"]) {
			const model = {
				adapter,
				model: "chosen",
				...(adapter === "claude-cli" ? { command: "explicit-cli" } : { endpoint: "http://localhost:5000" }),
			};
			const save = (consent: boolean) =>
				writeFileSync(
					`${conf}/config.json`,
					JSON.stringify({ mail: { provider: "gog", allowMailToLeaveMachine: consent }, models: { [role]: model } }),
					{ mode: 0o600 },
				);
			save(false);
			expect(() => mailConfig(conf)).toThrow("allowMailToLeaveMachine");
			save(true);
			expect(Object.values(mailConfig(conf).models)).toContain("chosen");
		}
	}
});
