/** The design's example (docs/EMAIL-TRIAGE.md section 2), as written there. */
export const EXAMPLE = {
	provider: "gog",
	mode: "shadow",
	allowMailToLeaveMachine: true,
	gog: { command: "gog", account: "me@example.com", timeoutMs: 60000 },
	scope: { query: "in:inbox", lookbackDays: 7, maxMessagesPerRun: 200 },
	schedule: { times: ["07:30", "16:30"], days: "mon-fri", tz: "America/New_York", maxRunsPerDay: 4 },
	labels: { prefix: "Chamberlain" },
	models: { command: "claude", driver: "haiku", escalate: "sonnet", top: "opus" },
	budget: {
		driverCallsPerRun: 10,
		escalateCallsPerRun: 8,
		newsletterCallsPerRun: 3,
		topCallsPerRun: 0,
		inputTokensPerDay: 600000,
	},
	important: { senders: ["@school.example"], words: ["invoice", "due", "contract", "tax", "court", "overdue"] },
	newsletters: [{ name: "Unsupervised Learning", match: { listId: "<the newsletter's List-Id>" }, maxHighlights: 5 }],
	interests: ["AI security", "agents", "personal knowledge tools"],
	routes: [
		{ id: "steward", label: "Task for the Steward", kind: "steward" },
		{ id: "reader", label: "Readwise Reader", kind: "command", command: ["/path/to/save-to-reader"] },
		{ id: "obsidian", label: "Obsidian Reading list", kind: "file", file: "~/notes/Reading list.md" },
	],
	defaultRoute: "obsidian",
	cleanup: {
		unattended: { minApproval: 0.95, shadowDays: 14, minBatches: 10, sampleRate: 0.25, sampleWindow: 8 },
	},
};
