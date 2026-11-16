import type { BriefInput } from "../core/steward/brief.ts";

export const base: BriefInput = {
	mode: "test",
	repo: "/opt/chamberlain",
	state: "/home/u/.state/chamberlain",
	principal: "Ada",
	rights: "- DECIDE MYSELF: merge conflicts",
	rulings: "- R1: merge conflicts are the Steward's",
	operatingRules: "Use timeout, not gtimeout.",
	afk: { enteredAt: "2026-11-02T03:46:27Z", words: "keep things moving" },
	environments: [{ name: "main" }, { name: "laptop", environmentId: "laptop-id", mayBeOffline: true }],
	predecessor: "old-thread",
};
