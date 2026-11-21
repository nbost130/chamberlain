/** What the overhead monitor reads from config.json: its own section, and the Steward's model from the central selection (`models.steward`). */
import { cfg, thread } from "../config/layout.ts";
import { THREADS } from "../config/layout-schema.ts";
import { parseModels } from "../llm/selection.ts";
import type { Store } from "../store/store.ts";
import { type OverheadConfig, parseOverhead } from "./config.ts";
import type { OwnThreads } from "./managed.ts";
import { readOverheadState } from "./trigger.ts";

/** The Steward's model when `models.steward` is a T3 selection: the model whose rates price the Steward's tokens. */
function stewardModelOf(models: unknown): string | undefined {
	const steward = parseModels(models).steward;
	// Usage rows carry no executed model. Multiple approved choices cannot share a guessed price.
	return steward?.adapter === "t3" && !steward.fallbacks?.length ? steward.model : undefined;
}

/** The section with its defaults filled in (validated against `models.steward`), and the Steward's model when there is one. */
export function overheadSettings(conf: string): { cfg: OverheadConfig; model?: string } {
	const model = stewardModelOf(cfg(conf, "models"));
	return { cfg: parseOverhead(cfg(conf, "overhead"), model), ...(model ? { model } : {}) };
}

const ids = (list: readonly (string | undefined)[]): string[] => [
	...new Set(list.filter((t): t is string => typeof t === "string" && !!t)),
];

/**
 * The T3 threads Chamberlain runs itself, from its own records: the pinned Steward, Decisions and Desk threads (config.json `threads`), every
 * butler it launched (the butler ledger) and every investigator it opened (the overhead state). None is counted as managed; the butlers and
 * investigators are the threads it launched, whose spend is Chamberlain-caused. A past Steward is not listed; its `compact` events are skipped by kind.
 */
export function ownThreads(conf: string, store: Pick<Store, "butlers" | "state">): OwnThreads {
	return {
		pinned: ids(THREADS.map((role) => thread(conf, role))),
		butlers: ids(store.butlers.list().map((b) => b.thread)),
		investigators: ids(readOverheadState(store).investigations.map((i) => i.threadId)),
	};
}
