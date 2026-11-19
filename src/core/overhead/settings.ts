/** What the overhead monitor reads from config.json: its own section, and the Steward's model from the central selection (`models.steward`). */
import { cfg, thread } from "../config/layout.ts";
import { THREADS } from "../config/layout-schema.ts";
import { parseModels } from "../llm/selection.ts";
import type { Store } from "../store/store.ts";
import { type OverheadConfig, parseOverhead } from "./config.ts";
import { readOverheadState } from "./trigger.ts";

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

/**
 * The T3 threads Chamberlain runs itself, which are never counted as managed: the pinned Steward, Decisions and Desk threads, every butler it has
 * launched (the butler ledger) and every investigator it has opened. A past Steward is not listed here; its `compact` events are skipped by kind.
 */
export function ownThreads(conf: string, store: Pick<Store, "butlers" | "state">): string[] {
	const pinned = THREADS.map((role) => thread(conf, role));
	const butlers = store.butlers.list().map((b) => b.thread);
	const investigators = readOverheadState(store).investigations.map((i) => i.threadId);
	return [
		...new Set([...pinned, ...butlers, ...investigators].filter((t): t is string => typeof t === "string" && !!t)),
	];
}
