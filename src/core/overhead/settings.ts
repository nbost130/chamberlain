/** What the overhead monitor reads from config.json: its own section, and the Steward's model from the central selection (`models.steward`). */
import { cfg } from "../config/layout.ts";
import { parseModels } from "../llm/selection.ts";
import { type OverheadConfig, parseOverhead } from "./config.ts";

/** The Steward's model when `models.steward` is a T3 selection: the model whose rates price the Steward's tokens. */
function stewardModelOf(models: unknown): string | undefined {
	const steward = parseModels(models).steward;
	return steward?.adapter === "t3" ? steward.model : undefined;
}

/** The section with its defaults filled in (validated against `models.steward`), and the Steward's model when there is one. */
export function overheadSettings(conf: string): { cfg: OverheadConfig; model?: string } {
	const model = stewardModelOf(cfg(conf, "models"));
	return { cfg: parseOverhead(cfg(conf, "overhead"), model), ...(model ? { model } : {}) };
}
