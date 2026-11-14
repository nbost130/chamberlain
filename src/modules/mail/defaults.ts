/** The mail module's config: its shape, its defaults and the keys it knows. */
import type { Route } from "./routes.ts";
import type { Schedule } from "./schedule.ts";

export const PROVIDERS = ["none", "gog", "command"] as const;
type MailProviderName = (typeof PROVIDERS)[number];

type NewsletterMatch = { listId: string } | { sender: string };
export type Newsletter = { name: string; match: NewsletterMatch; maxHighlights: number };

export type MailConfig = {
	provider: MailProviderName;
	mode: "shadow" | "live";
	allowMailToLeaveMachine: boolean;
	gog: { command: string; account: string | null; timeoutMs: number; env: string[] };
	command: { argv: string[] | null; timeoutMs: number };
	scope: { query: string; lookbackDays: number; maxMessagesPerRun: number };
	schedule: Schedule;
	labels: { prefix: string };
	models: { command: string; driver: string; escalate: string; top: string };
	budget: {
		driverCallsPerRun: number;
		escalateCallsPerRun: number;
		newsletterCallsPerRun: number;
		topCallsPerRun: number;
		inputTokensPerDay: number;
	};
	important: { senders: string[]; words: string[] };
	newsletters: Newsletter[];
	interests: string[];
	routes: Route[];
	defaultRoute: string;
	cleanup: {
		unattended: {
			minApproval: number;
			shadowDays: number;
			minBatches: number;
			sampleRate: number;
			sampleWindow: number;
		};
	};
};

/** The floors of the unattended-archive mode: Nathan's answer to design question 3 (95% over a two-week shadow trial), and a batch count so a handful of lucky batches cannot pass. */
export const UNATTENDED_FLOORS = { minApproval: 0.95, shadowDays: 14, minBatches: 10 } as const;

export const MAIL_DEFAULTS: MailConfig = {
	provider: "none",
	mode: "shadow",
	allowMailToLeaveMachine: false,
	gog: { command: "gog", account: null, timeoutMs: 60_000, env: [] },
	command: { argv: null, timeoutMs: 60_000 },
	scope: { query: "in:inbox", lookbackDays: 7, maxMessagesPerRun: 200 },
	schedule: { times: ["07:30", "16:30"], days: "mon-fri", tz: "local", maxRunsPerDay: 4 },
	labels: { prefix: "Chamberlain" },
	models: { command: "claude", driver: "haiku", escalate: "sonnet", top: "opus" },
	budget: {
		driverCallsPerRun: 10,
		escalateCallsPerRun: 8,
		newsletterCallsPerRun: 3,
		topCallsPerRun: 0,
		inputTokensPerDay: 600_000,
	},
	important: { senders: [], words: ["invoice", "due", "contract", "tax", "court", "overdue"] },
	newsletters: [],
	interests: [],
	routes: [{ id: "steward", label: "Task for the Steward", kind: "steward" }],
	defaultRoute: "steward",
	cleanup: { unattended: { ...UNATTENDED_FLOORS, sampleRate: 0.25, sampleWindow: 8 } },
};

export const W = "mail";
export const KEYS = [
	"provider",
	"mode",
	"allowMailToLeaveMachine",
	"gog",
	"command",
	"scope",
	"schedule",
	"labels",
	"models",
	"budget",
	"important",
	"newsletters",
	"interests",
	"routes",
	"defaultRoute",
	"cleanup",
];
