/**
 * `sweep.idleParents.classifier` in config.json: the idle-thread classifier's settings. Off by default (`provider: "none"`): without
 * this section Chamberlain behaves exactly as it does without the feature and makes no model call. Unknown keys throw, as elsewhere.
 *
 * Text leaves the machine only with two switches: a provider that sends it (`jev`, `haiku`) AND `allowTextToLeaveMachine: true`. Either
 * provider without the second switch is refused here, at config load, never at the first call.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type Bank, DEFAULT_BANK, parseBank, type Thresholds } from "./bank.ts";
import { JEV_DEFAULT_MODEL, PROVIDERS, type ProviderName } from "./providers.ts";
import type { RedactConfig, SendConfig } from "./state.ts";

export type ClassifierMode = "shadow" | "live";
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

type Obj = Record<string, unknown>;
function object(raw: unknown, where: string, keys: readonly string[]): Obj {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error(`${where}: expected an object`);
	const o = raw as Obj;
	for (const k of Object.keys(o))
		if (!keys.includes(k)) throw Error(`${where}: unknown key "${k}" (known: ${keys.join(", ")})`);
	return o;
}
const bool = (o: Obj, k: string, where: string, d: boolean): boolean => {
	if (o[k] === undefined) return d;
	if (typeof o[k] !== "boolean") throw Error(`${where}: ${k} must be true or false`);
	return o[k] as boolean;
};
const num = (o: Obj, k: string, where: string, d: number, whole: boolean, zeroOk = false): number => {
	const v = o[k];
	if (v === undefined) return d;
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || (!zeroOk && v === 0) || (whole && !Number.isInteger(v)))
		throw Error(`${where}: ${k} must be a ${zeroOk ? "non-negative" : "positive"} ${whole ? "whole " : ""}number`);
	return v;
};
const str = (o: Obj, k: string, where: string, d: string): string => {
	const v = o[k];
	if (v === undefined) return d;
	if (typeof v !== "string" || !v.trim()) throw Error(`${where}: ${k} must be a non-empty string`);
	return v;
};
const probability = (v: unknown, where: string): number => {
	if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)
		throw Error(`${where} must be a number from 0 to 1`);
	return v;
};

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

/** Pure: the section, with defaults for what it leaves out. Anything it does not understand throws. */
export function parseClassifier(raw: unknown): ClassifierConfig {
	const d = CLASSIFIER_DEFAULTS;
	if (raw === undefined) return structuredClone(d);
	const o = object(raw, W, KEYS);
	const provider = o.provider ?? d.provider;
	if (typeof provider !== "string" || !(PROVIDERS as readonly string[]).includes(provider))
		throw Error(`${W}: provider must be one of ${PROVIDERS.join(", ")}`);
	const mode = o.mode ?? d.mode;
	if (mode !== "shadow" && mode !== "live") throw Error(`${W}: mode must be shadow or live`);
	const allow = bool(o, "allowTextToLeaveMachine", W, d.allowTextToLeaveMachine);
	if (SENDS_TEXT.includes(provider as ProviderName) && !allow)
		throw Error(
			`${W}: provider "${provider}" sends thread text off this machine; set "allowTextToLeaveMachine": true to allow it, or use "rules" or "none"`,
		);
	const questions = str(o, "questions", W, d.questions);

	const thresholds: Thresholds = { ...d.thresholds };
	if (o.thresholds !== undefined) {
		if (!o.thresholds || typeof o.thresholds !== "object" || Array.isArray(o.thresholds))
			throw Error(`${W}.thresholds: expected an object`);
		for (const [k, v] of Object.entries(o.thresholds as Obj)) thresholds[k] = probability(v, `${W}.thresholds.${k}`);
	}

	const sendW = `${W}.send`;
	const so = o.send === undefined ? {} : object(o.send, sendW, ["lastChars", "previousChars", "title"]);
	const send: SendConfig = {
		lastChars: num(so, "lastChars", sendW, d.send.lastChars, true),
		previousChars: num(so, "previousChars", sendW, d.send.previousChars, true, true),
		title: bool(so, "title", sendW, d.send.title),
	};

	const redW = `${W}.redact`;
	const ro = o.redact === undefined ? {} : object(o.redact, redW, ["builtin", "command"]);
	let command: string[] | null = null;
	if (ro.command !== undefined && ro.command !== null) {
		if (!Array.isArray(ro.command) || !ro.command.length || !ro.command.every((x) => typeof x === "string" && x))
			throw Error(`${redW}: command must be null or ["program", "arg", ...]`);
		command = ro.command as string[];
	}
	const redact: RedactConfig = { builtin: bool(ro, "builtin", redW, d.redact.builtin), command };

	const budW = `${W}.budget`;
	const bo = o.budget === undefined ? {} : object(o.budget, budW, ["maxPerRun", "maxCallsPerDay", "maxUsdPerDay"]);
	const budget = {
		maxPerRun: num(bo, "maxPerRun", budW, d.budget.maxPerRun, true),
		maxCallsPerDay: num(bo, "maxCallsPerDay", budW, d.budget.maxCallsPerDay, true),
		maxUsdPerDay: num(bo, "maxUsdPerDay", budW, d.budget.maxUsdPerDay, false),
	};

	for (const k of ["autoNudge", "autoSettle"] as const)
		if (bool(o, k, W, false))
			throw Error(`${W}: ${k} is designed but not in this build; leave it out or set it to false`);

	const jevW = `${W}.jev`;
	const jo = o.jev === undefined ? {} : object(o.jev, jevW, ["model", "keyFile", "timeoutMs"]);
	const keyFile = str(jo, "keyFile", jevW, d.jev.keyFile);
	if (!/^[\w.-]+$/.test(keyFile) || keyFile.startsWith("."))
		throw Error(`${jevW}: keyFile must be a plain file name in the config directory's secrets/`);
	const jev = {
		model: str(jo, "model", jevW, d.jev.model),
		keyFile,
		timeoutMs: num(jo, "timeoutMs", jevW, d.jev.timeoutMs, true),
	};

	const hW = `${W}.haiku`;
	const ho = o.haiku === undefined ? {} : object(o.haiku, hW, ["command", "model", "timeoutMs"]);
	const haiku = {
		command: str(ho, "command", hW, d.haiku.command),
		model: str(ho, "model", hW, d.haiku.model),
		timeoutMs: num(ho, "timeoutMs", hW, d.haiku.timeoutMs, true),
	};

	return {
		provider: provider as ProviderName,
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
