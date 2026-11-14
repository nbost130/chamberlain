import { DEFAULT_BANK } from "../core/classifier/bank.ts";
import type { SentState } from "../core/classifier/state.ts";

export const STATE: SentState = {
	thread_title: "Fix the gate",
	previous_message: { from: "human", text: "is it done?" },
	last_message: "Done. Say go and I'll merge it.",
};

export const IDS = DEFAULT_BANK.map((q) => q.id);

export const half = Object.fromEntries(IDS.map((id) => [id, 0.5]));

export const KEY = ["test", "key", "value"].join("-");
