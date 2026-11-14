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
import { KEYS, MAIL_DEFAULTS, type MailConfig, type Newsletter, PROVIDERS, UNATTENDED_FLOORS, W } from "./defaults.ts";
import { parseRoutes, type Route } from "./routes.ts";
import { parseSchedule } from "./schedule.ts";

/** A section that may be left out whole: its object, or an empty one. */
const section = (o: Obj, k: string, keys: readonly string[]): Obj =>
	o[k] === undefined ? {} : object(o[k], `${W}.${k}`, keys);

/** A list of non-empty strings, each at most `max` characters, at most `limit` of them. */
function strings(
	v: unknown,
	where: string,
	d: string[],
	{ max = 120, limit = 100 }: { max?: number; limit?: number } = {},
): string[] {
	if (v === undefined) return [...d];
	if (!Array.isArray(v) || v.length > limit) throw Error(`${where}: expected a list of at most ${limit} strings`);
	for (const x of v)
		if (typeof x !== "string" || !x.trim() || x.length > max)
			throw Error(`${where}: every entry must be a non-empty string of at most ${max} characters`);
	return [...v] as string[];
}

function parseGate(o: Obj, d: MailConfig) {
	return {
		provider: oneOf(o, "provider", W, { allowed: PROVIDERS, d: d.provider }),
		mode: modeOf(o, W, d.mode),
		allow: bool(o, "allowMailToLeaveMachine", W, d.allowMailToLeaveMachine),
	};
}

function parseGog(o: Obj, d: MailConfig): MailConfig["gog"] {
	const where = `${W}.gog`;
	const g = section(o, "gog", ["command", "account", "timeoutMs", "env"]);
	const account = g.account === undefined ? d.gog.account : str(g, "account", where, "");
	const env = strings(g.env, `${where}.env`, d.gog.env, { max: 64 });
	for (const name of env)
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name === "GOG_ACCESS_TOKEN")
			throw Error(`${where}.env: "${name}" is not a variable name this module may pass to gog`);
	return {
		command: str(g, "command", where, d.gog.command),
		account,
		timeoutMs: num(g, "timeoutMs", where, { d: d.gog.timeoutMs, whole: true }),
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
	return { argv, timeoutMs: num(c, "timeoutMs", where, { d: d.command.timeoutMs, whole: true }) };
}

function parseScope(o: Obj, d: MailConfig): MailConfig["scope"] {
	const where = `${W}.scope`;
	const s = section(o, "scope", ["query", "lookbackDays", "maxMessagesPerRun"]);
	return {
		query: cappedStr(s, "query", where, { d: d.scope.query, max: 500 }),
		lookbackDays: num(s, "lookbackDays", where, { d: d.scope.lookbackDays, whole: true }),
		maxMessagesPerRun: num(s, "maxMessagesPerRun", where, { d: d.scope.maxMessagesPerRun, whole: true }),
	};
}

/** A non-empty string of at most `max` characters. */
function cappedStr(o: Obj, k: string, where: string, { d, max }: { d: string; max: number }): string {
	const v = str(o, k, where, d);
	if (v.length > max) throw Error(`${where}: ${k} must be at most ${max} characters`);
	return v;
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
	const top = num(b, "topCallsPerRun", where, { d: d.budget.topCallsPerRun, whole: true, zeroOk: true });
	if (top > 1) throw Error(`${where}: topCallsPerRun must be 0 or 1`);
	return {
		driverCallsPerRun: num(b, "driverCallsPerRun", where, { d: d.budget.driverCallsPerRun, whole: true, zeroOk: true }),
		escalateCallsPerRun: num(b, "escalateCallsPerRun", where, {
			d: d.budget.escalateCallsPerRun,
			whole: true,
			zeroOk: true,
		}),
		newsletterCallsPerRun: num(b, "newsletterCallsPerRun", where, {
			d: d.budget.newsletterCallsPerRun,
			whole: true,
			zeroOk: true,
		}),
		topCallsPerRun: top,
		inputTokensPerDay: num(b, "inputTokensPerDay", where, { d: d.budget.inputTokensPerDay, whole: true }),
	};
}

function parseImportant(o: Obj, d: MailConfig): MailConfig["important"] {
	const where = `${W}.important`;
	const i = section(o, "important", ["senders", "words"]);
	return {
		senders: strings(i.senders, `${where}.senders`, d.important.senders, { max: 254 }),
		words: strings(i.words, `${where}.words`, d.important.words, { max: 60 }),
	};
}

function parseNewsletter(raw: unknown, at: string): Newsletter {
	const n = object(raw, at, ["name", "match", "maxHighlights"]);
	const m = object(n.match, `${at}.match`, ["listId", "sender"]);
	const [key, ...more] = Object.keys(m);
	if (key === undefined || more.length) throw Error(`${at}.match: give exactly one of listId or sender`);
	const value = required(m, key, `${at}.match`);
	const maxHighlights = num(n, "maxHighlights", at, { d: 5, whole: true });
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
		shadowDays: num(u, "shadowDays", where, { d: was.shadowDays, whole: true }),
		minBatches: num(u, "minBatches", where, { d: was.minBatches, whole: true }),
		sampleRate: num(u, "sampleRate", where, { d: was.sampleRate, whole: false }),
		sampleWindow: num(u, "sampleWindow", where, { d: was.sampleWindow, whole: true }),
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
	if (!c.routes.some((r) => r.id === c.defaultRoute))
		throw Error(
			`${W}: defaultRoute "${c.defaultRoute}" is not one of the routes (${c.routes.map((r) => r.id).join(", ")})`,
		);
	if (c.provider === "none") return;
	if (c.provider === "command" && !c.command.argv)
		throw Error(`${W}: provider "command" needs command.argv, the operator's own program`);
	if (c.models.driver !== "none" && !c.allowMailToLeaveMachine)
		throw Error(
			`${W}: the model "${c.models.driver}" reads mail text, which leaves this machine; set "allowMailToLeaveMachine": true to allow it, or set models.driver to "none" for rules only`,
		);
}

/**
 * The route offered first when none is named: the first `file` route, because a reading list in the operator's notes is where a highlight goes
 * until a route has been learned (the answer to design question 2); a list with no file route offers its first route.
 */
const defaultRouteOf = (routes: Route[]): string => (routes.find((r) => r.kind === "file") ?? routes[0])?.id ?? "";

/** Pure: the section, with defaults for what it leaves out. Anything it does not understand throws. */
export function parseMail(raw: unknown): MailConfig {
	const d = MAIL_DEFAULTS;
	if (raw === undefined) return structuredClone(d);
	const o = object(raw, W, KEYS);
	const { provider, mode, allow } = parseGate(o, d);
	const routes = parseRoutes(o.routes, `${W}.routes`, d.routes);
	const defaultRoute = str(o, "defaultRoute", W, defaultRouteOf(routes));
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
		interests: strings(o.interests, `${W}.interests`, d.interests, { max: 60, limit: 50 }),
		routes,
		defaultRoute,
		cleanup: { unattended: parseUnattended(o, d) },
	};
	crossCheck(c);
	return c;
}

/** Whether the section turns the module on: a provider other than "none". Throws on a section it cannot parse. */
export const mailEnabled = (raw: unknown): boolean => parseMail(raw).provider !== "none";
