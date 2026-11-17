import { createHash } from "node:crypto";
import { ReaderError, type ReaderReply, readModel, selectedReader } from "../llm/reader.ts";
import { haikuAnswers, haikuSystem, type Provider, ProviderError } from "./providers.ts";

/** Cache identity includes endpoint, options and adapter, not merely the model's display name. */
export function modelProvider(conf: string): Provider {
	const selection = selectedReader(conf, "classifier");
	if (selection.adapter === "openai-chat" && selection.accountingUsdPerCall === undefined)
		throw Error(
			"models.classifier.accountingUsdPerCall is required for HTTP budget accounting (zero only for an unbilled endpoint)",
		);
	const identity = createHash("sha256").update(JSON.stringify(selection)).digest("hex").slice(0, 16);
	return {
		name: "model",
		model: `${selection.model}:${identity}`,
		classify: async (state, bank) => {
			const start = performance.now();
			let r: ReaderReply;
			try {
				r = await readModel(selection, { system: haikuSystem(bank), text: JSON.stringify({ state }) }, conf);
			} catch (e) {
				throw new ProviderError(
					"configured model request failed",
					e instanceof ReaderError ? e.usage : { costUsd: selection.accountingUsdPerCall },
				);
			}
			const usage = { ...r, costUsd: selection.accountingUsdPerCall ?? r.costUsd };
			return {
				answers: haikuAnswers({ result: r.text }, bank, usage),
				model: r.model,
				inputTokens: r.inputTokens,
				costUsd: usage.costUsd,
				latencyMs: Math.round(performance.now() - start),
			};
		},
	};
}
