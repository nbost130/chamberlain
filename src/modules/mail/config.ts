/**
 * `mail` in config.json: the optional email triage module's settings (docs/EMAIL-TRIAGE.md, section 2). Off by default: without this
 * section, or with `"provider": "none"`, Chamberlain behaves exactly as it does without the module. Unknown keys throw, as elsewhere, and a
 * key for a credential does not exist: the mail tool (gog, himalaya) keeps its own login and Chamberlain never sees it.
 *
 * Mail text leaves the machine only with two switches: a provider other than "none" together with a model that reads it
 * (`models.driver` anything but "none"), AND `allowMailToLeaveMachine: true`. Without the second switch the section is refused here, at
 * config load, never at the first call. `models.driver: "none"` is rules only: no model is called and no text leaves.
 *
 * `cleanup.unattended` holds only the numbers of the unattended-archive mode, and has no switch: the mode is off on every install and no
 * config key turns it on (section 5). Its floors (95% approval, a 14 day shadow period, 10 batches) cannot be configured away.
 */
import {
	bool,
	isArgv,
	modeOf,
	num,
	type Obj,
	object,
	oneOf,
	probability,
	required,
	str,
} from "../../core/config-fields.ts";
import { MODEL_ID } from "../../core/llm/cli.ts";
import { parseRoutes, type Route } from "./routes.ts";
import { parseSchedule, type Schedule } from "./schedule.ts";

const PROVIDERS = ["none", "gog", "command"] as const;
type MailProviderName = (typeof PROVIDERS)[number];

type NewsletterMatch = { listId: string } | { sender: string };
type Newsletter = { name: string; match: NewsletterMatch; maxHighlights: number };

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

const W = "mail";
const KEYS = [
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

/** A section that may be left out whole: its object, or an empty one. */
const section = (o: Obj, k: string, keys: readonly string[]): Obj =>
	o[k] === undefined ? {} : object(o[k], `${W}.${k}`, keys);

/** A list of non-empty strings, each at most `max` characters, at most `limit` of them. */
function strings(v: unknown, where: string, d: string[], max = 120, limit = 100): string[] {
	if (v === undefined) return [...d];
	if (!Array.isArray(v) || v.length > limit) throw Error(`${where}: expected a list of at most ${limit} strings`);
	for (const x of v)
		if (typeof x !== "string" || !x.trim() || x.length > max)
			throw Error(`${where}: every entry must be a non-empty string of at most ${max} characters`);
	return [...v] as string[];
}

function parseGate(o: Obj, d: MailConfig) {
	return {
		provider: oneOf(o, "provider", W, PROVIDERS, d.provider),
		mode: modeOf(o, W, d.mode),
		allow: bool(o, "allowMailToLeaveMachine", W, d.allowMailToLeaveMachine),
	};
}

function parseGog(o: Obj, d: MailConfig): MailConfig["gog"] {
	const where = `${W}.gog`;
	const g = section(o, "gog", ["command", "account", "timeoutMs", "env"]);
	const account = g.account === undefined ? d.gog.account : str(g, "account", where, "");
	const env = strings(g.env, `${where}.env`, d.gog.env, 64);
	for (const name of env)
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name === "GOG_ACCESS_TOKEN")
			throw Error(`${where}.env: "${name}" is not a variable name this module may pass to gog`);
	return {
		command: str(g, "command", where, d.gog.command),
		account,
		timeoutMs: num(g, "timeoutMs", where, d.gog.timeoutMs, true),
		env,
	};
}

function parseCommand(o: Obj, d: MailConfig): MailConfig["command"] {
	const where = `${W}.command`;
	const c = section(o, "command", ["argv", "timeoutMs"]);
	let argv = d.command.argv;
	if (c.argv !== undefined) {
		if (!isArgv(c.argv)) throw Error(`${where}: argv must be ["program", "arg", ...]`);
		argv = c.argv;
	}
	return { argv, timeoutMs: num(c, "timeoutMs", where, d.command.timeoutMs, true) };
}

function parseScope(o: Obj, d: MailConfig): MailConfig["scope"] {
	const where = `${W}.scope`;
	const s = section(o, "scope", ["query", "lookbackDays", "maxMessagesPerRun"]);
	return {
		query: str(s, "query", where, d.scope.query),
		lookbackDays: num(s, "lookbackDays", where, d.scope.lookbackDays, true),
		maxMessagesPerRun: num(s, "maxMessagesPerRun", where, d.scope.maxMessagesPerRun, true),
	};
}

/** The label prefix: a plain name, because a label is `<prefix>/<name>` and the provider refuses any other prefix. */
function parseLabels(o: Obj, d: MailConfig): MailConfig["labels"] {
	const prefix = str(section(o, "labels", ["prefix"]), "prefix", `${W}.labels`, d.labels.prefix);
	if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/.test(prefix))
		throw Error(`${W}.labels: prefix must be a plain name of at most 40 letters, digits, spaces, "_" or "-" (no "/")`);
	return { prefix };
}

/** The model names. `driver` may be "none": rules only, no model is called. */
function parseModels(o: Obj, d: MailConfig): MailConfig["models"] {
	const where = `${W}.models`;
	const m = section(o, "models", ["command", "driver", "escalate", "top"]);
	const out = {
		command: str(m, "command", where, d.models.command),
		driver: str(m, "driver", where, d.models.driver),
		escalate: str(m, "escalate", where, d.models.escalate),
		top: str(m, "top", where, d.models.top),
	};
	for (const k of ["driver", "escalate", "top"] as const)
		if (!MODEL_ID.test(out[k])) throw Error(`${where}: ${k} is not a model name`);
	return out;
}

function parseBudget(o: Obj, d: MailConfig): MailConfig["budget"] {
	const where = `${W}.budget`;
	const b = section(o, "budget", [
		"driverCallsPerRun",
		"escalateCallsPerRun",
		"newsletterCallsPerRun",
		"topCallsPerRun",
		"inputTokensPerDay",
	]);
	const top = num(b, "topCallsPerRun", where, d.budget.topCallsPerRun, true, true);
	if (top > 1) throw Error(`${where}: topCallsPerRun must be 0 or 1`);
	return {
		driverCallsPerRun: num(b, "driverCallsPerRun", where, d.budget.driverCallsPerRun, true, true),
		escalateCallsPerRun: num(b, "escalateCallsPerRun", where, d.budget.escalateCallsPerRun, true, true),
		newsletterCallsPerRun: num(b, "newsletterCallsPerRun", where, d.budget.newsletterCallsPerRun, true, true),
		topCallsPerRun: top,
		inputTokensPerDay: num(b, "inputTokensPerDay", where, d.budget.inputTokensPerDay, true),
	};
}

function parseImportant(o: Obj, d: MailConfig): MailConfig["important"] {
	const where = `${W}.important`;
	const i = section(o, "important", ["senders", "words"]);
	return {
		senders: strings(i.senders, `${where}.senders`, d.important.senders, 254),
		words: strings(i.words, `${where}.words`, d.important.words, 60),
	};
}

function parseNewsletter(raw: unknown, at: string): Newsletter {
	const n = object(raw, at, ["name", "match", "maxHighlights"]);
	const m = object(n.match, `${at}.match`, ["listId", "sender"]);
	const [key, ...more] = Object.keys(m);
	if (key === undefined || more.length) throw Error(`${at}.match: give exactly one of listId or sender`);
	const value = required(m, key, `${at}.match`);
	const maxHighlights = num(n, "maxHighlights", at, 5, true);
	if (maxHighlights > 5) throw Error(`${at}: maxHighlights must be at most 5`);
	return {
		name: required(n, "name", at),
		match: key === "listId" ? { listId: value } : { sender: value },
		maxHighlights,
	};
}

function parseNewsletters(o: Obj): Newsletter[] {
	if (o.newsletters === undefined) return [];
	if (!Array.isArray(o.newsletters) || o.newsletters.length > 50)
		throw Error(`${W}.newsletters: expected a list of at most 50 newsletters`);
	const list = o.newsletters.map((n, i) => parseNewsletter(n, `${W}.newsletters[${i}]`));
	const names = list.map((n) => n.name);
	if (new Set(names).size !== names.length) throw Error(`${W}.newsletters: each name must be different`);
	return list;
}

/** The unattended-archive numbers. No key turns the mode on; each floor refuses a weaker setting. */
function parseUnattended(o: Obj, d: MailConfig): MailConfig["cleanup"]["unattended"] {
	const where = `${W}.cleanup.unattended`;
	const c = section(o, "cleanup", ["unattended"]);
	const keys = ["minApproval", "shadowDays", "minBatches", "sampleRate", "sampleWindow"];
	const u = c.unattended === undefined ? {} : object(c.unattended, where, keys);
	const was = d.cleanup.unattended;
	const out = {
		minApproval: u.minApproval === undefined ? was.minApproval : probability(u.minApproval, `${where}.minApproval`),
		shadowDays: num(u, "shadowDays", where, was.shadowDays, true),
		minBatches: num(u, "minBatches", where, was.minBatches, true),
		sampleRate: num(u, "sampleRate", where, was.sampleRate, false),
		sampleWindow: num(u, "sampleWindow", where, was.sampleWindow, true),
	};
	for (const k of ["minApproval", "shadowDays", "minBatches"] as const)
		if (out[k] < UNATTENDED_FLOORS[k])
			throw Error(
				`${where}: ${k} must be at least ${UNATTENDED_FLOORS[k]}; the unattended mode is earned, not configured`,
			);
	if (out.sampleRate > 1) throw Error(`${where}: sampleRate must be a number above 0 and at most 1`);
	return out;
}

/** The checks that read across sections: what a provider needs, the switch for text that leaves the machine, and a default route that exists. */
function crossCheck(c: MailConfig): void {
	if (c.provider === "none") return;
	if (c.provider === "command" && !c.command.argv)
		throw Error(`${W}: provider "command" needs command.argv, the operator's own program`);
	if (c.models.driver !== "none" && !c.allowMailToLeaveMachine)
		throw Error(
			`${W}: the model "${c.models.driver}" reads mail text, which leaves this machine; set "allowMailToLeaveMachine": true to allow it, or set models.driver to "none" for rules only`,
		);
	if (!c.routes.some((r) => r.id === c.defaultRoute))
		throw Error(
			`${W}: defaultRoute "${c.defaultRoute}" is not one of the routes (${c.routes.map((r) => r.id).join(", ")})`,
		);
}

/** Pure: the section, with defaults for what it leaves out. Anything it does not understand throws. */
export function parseMail(raw: unknown): MailConfig {
	const d = MAIL_DEFAULTS;
	if (raw === undefined) return structuredClone(d);
	const o = object(raw, W, KEYS);
	const { provider, mode, allow } = parseGate(o, d);
	const routes = parseRoutes(o.routes, `${W}.routes`, d.routes);
	const defaultRoute = str(
		o,
		"defaultRoute",
		W,
		routes.some((r) => r.id === d.defaultRoute) ? d.defaultRoute : (routes[0]?.id ?? ""),
	);
	const c: MailConfig = {
		provider,
		mode,
		allowMailToLeaveMachine: allow,
		gog: parseGog(o, d),
		command: parseCommand(o, d),
		scope: parseScope(o, d),
		schedule: parseSchedule(o.schedule, `${W}.schedule`, d.schedule),
		labels: parseLabels(o, d),
		models: parseModels(o, d),
		budget: parseBudget(o, d),
		important: parseImportant(o, d),
		newsletters: parseNewsletters(o),
		interests: strings(o.interests, `${W}.interests`, d.interests, 60, 50),
		routes,
		defaultRoute,
		cleanup: { unattended: parseUnattended(o, d) },
	};
	crossCheck(c);
	return c;
}

/** Whether the section turns the module on: a provider other than "none". Throws on a section it cannot parse. */
export const mailEnabled = (raw: unknown): boolean => parseMail(raw).provider !== "none";
