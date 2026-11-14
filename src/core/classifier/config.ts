/**
 * `sweep.idleParents.classifier` in config.json: the idle-thread classifier's settings. Off by default (`provider: "none"`): without
 * this section Chamberlain behaves exactly as it does without the feature and makes no model call. Unknown keys throw, as elsewhere.
 *
 * Text leaves the machine only with two switches: a provider that sends it (`jev`, `haiku`) AND `allowTextToLeaveMachine: true`. Either
 * provider without the second switch is refused here, at config load, never at the first call.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { bool, isArgv, modeOf, num, type Obj, object, oneOf, probability, str } from "../config-fields.ts";
import { type Bank, DEFAULT_BANK, parseBank, type Thresholds } from "./bank.ts";
import { JEV_DEFAULT_MODEL, PROVIDERS, type ProviderName } from "./providers.ts";
import type { RedactConfig, SendConfig } from "./state.ts";

type ClassifierMode = "shadow" | "live";
export type ClassifierConfig = {
	provider: ProviderName;
	mode: ClassifierMode;
	allowTextToLeaveMachine: boolean;
	/** "default", or a path to a bank file (relative to the config directory). */
	questions: string;
	thresholds: Thresholds;
	send: SendConfig;
	redact: RedactConfig;
	budget: { maxPerRun: number; maxCallsPerDay: number; maxUsdPerDay: number };
	armedGraceMinutes: number;
	/** Designed, not in this build: only `false` is accepted. */
	autoNudge: false;
	autoSettle: false;
	jev: { model: string; keyFile: string; timeoutMs: number };
	haiku: { command: string; model: string; timeoutMs: number };
};

export const CLASSIFIER_DEFAULTS: ClassifierConfig = {
	provider: "none",
	mode: "shadow",
	allowTextToLeaveMachine: false,
	questions: "default",
	thresholds: { default: 0.5 },
	send: { lastChars: 1500, previousChars: 400, title: true },
	redact: { builtin: true, command: null },
	budget: { maxPerRun: 20, maxCallsPerDay: 500, maxUsdPerDay: 0.25 },
	armedGraceMinutes: 360,
	autoNudge: false,
	autoSettle: false,
	jev: { model: JEV_DEFAULT_MODEL, keyFile: "typesafe.key", timeoutMs: 10_000 },
	haiku: { command: "claude", model: "haiku", timeoutMs: 60_000 },
};

/** Providers that send the redacted state off the machine. */
export const SENDS_TEXT: readonly ProviderName[] = ["jev", "haiku"];
const W = "sweep.idleParents.classifier";

const KEYS = [
	"provider",
	"mode",
	"allowTextToLeaveMachine",
	"questions",
	"thresholds",
	"send",
	"redact",
	"budget",
	"armedGraceMinutes",
	"autoNudge",
	"autoSettle",
	"jev",
	"haiku",
];

type Defaults = ClassifierConfig;

/** The provider, the mode, the text-leaves-the-machine switch and the bank name: the checks that come first. */
function parseGate(o: Obj, d: Defaults) {
	const provider = oneOf(o, "provider", W, PROVIDERS, d.provider);
	const mode = modeOf(o, W, d.mode);
	const allow = bool(o, "allowTextToLeaveMachine", W, d.allowTextToLeaveMachine);
	if (SENDS_TEXT.includes(provider) && !allow)
		throw Error(
			`${W}: provider "${provider}" sends thread text off this machine; set "allowTextToLeaveMachine": true to allow it, or use "rules" or "none"`,
		);
	const questions = str(o, "questions", W, d.questions);
	return { provider, mode, allow, questions };
}

function parseThresholds(o: Obj, d: Defaults): Thresholds {
	const thresholds: Thresholds = { ...d.thresholds };
	if (o.thresholds !== undefined) {
		if (!o.thresholds || typeof o.thresholds !== "object" || Array.isArray(o.thresholds))
			throw Error(`${W}.thresholds: expected an object`);
		for (const [k, v] of Object.entries(o.thresholds as Obj)) thresholds[k] = probability(v, `${W}.thresholds.${k}`);
	}
	return thresholds;
}

function parseSend(o: Obj, d: Defaults): SendConfig {
	const sendW = `${W}.send`;
	const so = o.send === undefined ? {} : object(o.send, sendW, ["lastChars", "previousChars", "title"]);
	return {
		lastChars: num(so, "lastChars", sendW, d.send.lastChars, true),
		previousChars: num(so, "previousChars", sendW, d.send.previousChars, true, true),
		title: bool(so, "title", sendW, d.send.title),
	};
}

function parseRedact(o: Obj, d: Defaults): RedactConfig {
	const redW = `${W}.redact`;
	const ro = o.redact === undefined ? {} : object(o.redact, redW, ["builtin", "command"]);
	let command: string[] | null = null;
	if (ro.command !== undefined && ro.command !== null) {
		if (!isArgv(ro.command)) throw Error(`${redW}: command must be null or ["program", "arg", ...]`);
		command = ro.command;
	}
	return { builtin: bool(ro, "builtin", redW, d.redact.builtin), command };
}

function parseBudget(o: Obj, d: Defaults): ClassifierConfig["budget"] {
	const budW = `${W}.budget`;
	const bo = o.budget === undefined ? {} : object(o.budget, budW, ["maxPerRun", "maxCallsPerDay", "maxUsdPerDay"]);
	return {
		maxPerRun: num(bo, "maxPerRun", budW, d.budget.maxPerRun, true),
		maxCallsPerDay: num(bo, "maxCallsPerDay", budW, d.budget.maxCallsPerDay, true),
		maxUsdPerDay: num(bo, "maxUsdPerDay", budW, d.budget.maxUsdPerDay, false),
	};
}

function parseJev(o: Obj, d: Defaults): ClassifierConfig["jev"] {
	const jevW = `${W}.jev`;
	const jo = o.jev === undefined ? {} : object(o.jev, jevW, ["model", "keyFile", "timeoutMs"]);
	const keyFile = str(jo, "keyFile", jevW, d.jev.keyFile);
	if (!/^[\w.-]+$/.test(keyFile) || keyFile.startsWith("."))
		throw Error(`${jevW}: keyFile must be a plain file name in the config directory's secrets/`);
	return {
		model: str(jo, "model", jevW, d.jev.model),
		keyFile,
		timeoutMs: num(jo, "timeoutMs", jevW, d.jev.timeoutMs, true),
	};
}

function parseHaiku(o: Obj, d: Defaults): ClassifierConfig["haiku"] {
	const hW = `${W}.haiku`;
	const ho = o.haiku === undefined ? {} : object(o.haiku, hW, ["command", "model", "timeoutMs"]);
	return {
		command: str(ho, "command", hW, d.haiku.command),
		model: str(ho, "model", hW, d.haiku.model),
		timeoutMs: num(ho, "timeoutMs", hW, d.haiku.timeoutMs, true),
	};
}

/** Pure: the section, with defaults for what it leaves out. Anything it does not understand throws. */
export function parseClassifier(raw: unknown): ClassifierConfig {
	const d = CLASSIFIER_DEFAULTS;
	if (raw === undefined) return structuredClone(d);
	const o = object(raw, W, KEYS);
	const { provider, mode, allow, questions } = parseGate(o, d);
	const thresholds = parseThresholds(o, d);
	const send = parseSend(o, d);
	const redact = parseRedact(o, d);
	const budget = parseBudget(o, d);
	for (const k of ["autoNudge", "autoSettle"] as const)
		if (bool(o, k, W, false))
			throw Error(`${W}: ${k} is designed but not in this build; leave it out or set it to false`);
	const jev = parseJev(o, d);
	const haiku = parseHaiku(o, d);
	return {
		provider,
		mode,
		allowTextToLeaveMachine: allow,
		questions,
		thresholds,
		send,
		redact,
		budget,
		armedGraceMinutes: num(o, "armedGraceMinutes", W, d.armedGraceMinutes, false, true),
		autoNudge: false,
		autoSettle: false,
		jev,
		haiku,
	};
}

/** The bank a config names, checked, with every threshold naming one of its questions. Throws naming what is wrong. */
export function loadBank(conf: string, c: Pick<ClassifierConfig, "questions" | "thresholds">): Bank {
	let bank: Bank;
	if (c.questions === "default") bank = DEFAULT_BANK;
	else {
		const path = isAbsolute(c.questions) ? c.questions : join(conf, c.questions);
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(path, "utf8"));
		} catch (e) {
			throw Error(
				`${W}.questions: cannot read ${c.questions} as JSON (${(e as Error).message.slice(0, 120).toWellFormed()})`,
			);
		}
		bank = parseBank(raw, c.questions);
	}
	const ids = new Set(bank.map((q) => q.id));
	for (const k of Object.keys(c.thresholds))
		if (k !== "default" && !ids.has(k)) throw Error(`${W}.thresholds: "${k}" is not a question in the bank`);
	return bank;
}
