import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { DEFAULT_BANK } from "./bank.ts";
import { modelProvider } from "./model-provider.ts";
import { ProviderError } from "./providers.ts";

test.each([0, 1])(
	"billed CLI errors with exit %i preserve usage and never echo the model's error text",
	async (code) => {
		const conf = mkdtempSync(`${tmpdir()}/model-billing-`);
		try {
			const command = `${conf}/reader`;
			writeFileSync(
				command,
				`#!/usr/bin/env bun\nawait Bun.stdin.text();\nconsole.log(JSON.stringify({is_error:true,total_cost_usd:0.12,usage:{input_tokens:42},result:"PRIVATE MODEL RESPONSE"}));\nprocess.exit(${code});\n`,
				{ mode: 0o700 },
			);
			writeFileSync(
				`${conf}/config.json`,
				JSON.stringify({ models: { classifier: { adapter: "claude-cli", command, model: "explicit" } } }),
				{ mode: 0o600 },
			);
			const result = await modelProvider(conf)
				.classify({ previous_message: { from: "none", text: "" }, last_message: "private" }, DEFAULT_BANK)
				.catch((e) => e);
			expect(result).toBeInstanceOf(ProviderError);
			expect(result.usage).toEqual({ costUsd: 0.12, inputTokens: 42 });
			expect(result.message).not.toContain("PRIVATE MODEL RESPONSE");
		} finally {
			rmSync(conf, { recursive: true, force: true });
		}
	},
);
