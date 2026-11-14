import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIdleParents } from "../idle-parents.ts";
import { parseSweepConfig } from "../sweep.ts";
import { DEFAULT_BANK } from "./bank.ts";
import { CLASSIFIER_DEFAULTS, loadBank, parseClassifier } from "./config.ts";

describe("sweep.idleParents.classifier", () => {
	test("off by default: provider none, shadow mode, no text may leave", () => {
		expect(parseClassifier(undefined)).toEqual(CLASSIFIER_DEFAULTS);
		expect(parseClassifier({})).toEqual(CLASSIFIER_DEFAULTS);
		expect(CLASSIFIER_DEFAULTS).toMatchObject({ provider: "none", mode: "shadow", allowTextToLeaveMachine: false });
		expect(parseIdleParents(undefined).classifier.provider).toBe("none");
	});
	test("the design's defaults, key for key", () =>
		expect(CLASSIFIER_DEFAULTS).toEqual({
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
			jev: { model: "jev-1.14.0", keyFile: "typesafe.key", timeoutMs: 10_000 },
			haiku: { command: "claude", model: "haiku", timeoutMs: 60_000 },
		}));
	test("the design's example parses as written", () => {
		const c = parseClassifier({
			provider: "jev",
			mode: "shadow",
			allowTextToLeaveMachine: true,
			questions: "default",
			thresholds: { default: 0.5 },
			send: { lastChars: 1500, previousChars: 400, title: true },
			redact: { builtin: true, command: null },
			budget: { maxPerRun: 20, maxCallsPerDay: 500, maxUsdPerDay: 0.25 },
			armedGraceMinutes: 360,
			autoNudge: false,
			autoSettle: false,
			jev: { model: "jev-1.14.0", keyFile: "typesafe.key", timeoutMs: 10000 },
			haiku: { command: "claude", model: "haiku", timeoutMs: 60000 },
		});
		expect(c).toEqual({ ...CLASSIFIER_DEFAULTS, provider: "jev", allowTextToLeaveMachine: true });
	});
	test("jev and haiku are refused at load unless text is allowed to leave the machine; rules and none never need it", () => {
		for (const provider of ["jev", "haiku"] as const) {
			expect(() => parseClassifier({ provider })).toThrow('set "allowTextToLeaveMachine": true');
			expect(() => parseClassifier({ provider, allowTextToLeaveMachine: false })).toThrow("sends thread text off");
			expect(parseClassifier({ provider, allowTextToLeaveMachine: true }).provider).toBe(provider);
		}
		expect(parseClassifier({ provider: "rules" }).provider).toBe("rules");
		// The refusal reaches the sweep section, so the whole section is in error, never quietly running a sender.
		expect(() => parseSweepConfig({ idleParents: { classifier: { provider: "jev" } } })).toThrow(
			"allowTextToLeaveMachine",
		);
	});
	test("each setting can be given", () => {
		const c = parseClassifier({
			provider: "haiku",
			mode: "live",
			allowTextToLeaveMachine: true,
			questions: "bank.json",
			thresholds: { default: 0.6, asks_decision: 0.65 },
			send: { lastChars: 800, previousChars: 0, title: false },
			redact: { builtin: false, command: ["/usr/local/bin/redact", "--strict"] },
			budget: { maxPerRun: 5, maxCallsPerDay: 50, maxUsdPerDay: 0.05 },
			armedGraceMinutes: 120,
			jev: { model: "jev-latest", keyFile: "jev.key", timeoutMs: 3000 },
			haiku: { command: "/opt/claude", model: "claude-haiku-5-5", timeoutMs: 30000 },
		});
		expect(c).toEqual({
			provider: "haiku",
			mode: "live",
			allowTextToLeaveMachine: true,
			questions: "bank.json",
			thresholds: { default: 0.6, asks_decision: 0.65 },
			send: { lastChars: 800, previousChars: 0, title: false },
			redact: { builtin: false, command: ["/usr/local/bin/redact", "--strict"] },
			budget: { maxPerRun: 5, maxCallsPerDay: 50, maxUsdPerDay: 0.05 },
			armedGraceMinutes: 120,
			autoNudge: false,
			autoSettle: false,
			jev: { model: "jev-latest", keyFile: "jev.key", timeoutMs: 3000 },
			haiku: { command: "/opt/claude", model: "claude-haiku-5-5", timeoutMs: 30000 },
		});
	});
	test("anything it does not understand throws, at every level", () => {
		const bad: [unknown, string][] = [
			[[], "expected an object"],
			[{ colour: "blue" }, 'unknown key "colour"'],
			[{ provider: "gpt" }, "provider must be one of none, rules, jev, haiku"],
			[{ mode: "loud" }, "mode must be shadow or live"],
			[{ allowTextToLeaveMachine: "yes" }, "allowTextToLeaveMachine must be true or false"],
			[{ questions: "" }, "questions must be a non-empty string"],
			[{ thresholds: [] }, "thresholds: expected an object"],
			[{ thresholds: { asks_decision: 1.5 } }, "thresholds.asks_decision must be a number from 0 to 1"],
			[{ send: { lastChars: 0 } }, "lastChars must be a positive whole number"],
			[{ send: { lastChars: 10.5 } }, "lastChars must be a positive whole number"],
			[{ send: { previousChars: -1 } }, "previousChars must be a non-negative whole number"],
			[{ send: { more: 1 } }, 'send: unknown key "more"'],
			[{ redact: { command: "sed" } }, 'command must be null or ["program"'],
			[{ redact: { command: [] } }, "command must be null"],
			[{ redact: { builtin: 0 } }, "builtin must be true or false"],
			[{ budget: { maxPerRun: 0 } }, "maxPerRun must be a positive whole number"],
			[{ budget: { maxUsdPerDay: -1 } }, "maxUsdPerDay must be a positive number"],
			[{ budget: { maxDollars: 1 } }, 'budget: unknown key "maxDollars"'],
			[{ armedGraceMinutes: -5 }, "armedGraceMinutes must be a non-negative number"],
			[{ autoNudge: true }, "autoNudge is designed but not in this build"],
			[{ autoSettle: true }, "autoSettle is designed but not in this build"],
			[{ jev: { keyFile: "../../.ssh/id_ed25519" } }, "keyFile must be a plain file name"],
			[{ jev: { keyFile: ".hidden" } }, "keyFile must be a plain file name"],
			[{ jev: { timeoutMs: 0 } }, "timeoutMs must be a positive whole number"],
			[{ haiku: { command: "" } }, "command must be a non-empty string"],
			[{ haiku: { flags: [] } }, 'haiku: unknown key "flags"'],
		];
		for (const [raw, msg] of bad) expect(() => parseClassifier(raw)).toThrow(msg);
		expect(() => parseIdleParents({ classifier: { provider: "gpt" } })).toThrow("provider must be one of");
	});
	test("autoNudge and autoSettle may be written as false (the design's example has them)", () =>
		expect(parseClassifier({ autoNudge: false, autoSettle: false })).toEqual(CLASSIFIER_DEFAULTS));
});

describe("loadBank", () => {
	const dir = () => mkdtempSync(join(tmpdir(), "bank-"));
	test("default is the shipped bank", () => expect(loadBank(dir(), CLASSIFIER_DEFAULTS)).toBe(DEFAULT_BANK));
	test("a path is read relative to the config directory and checked", () => {
		const d = dir();
		const bank = [{ id: "stuck", ask: "Is it stuck?", yes: "It says so.", no: "It does not.", fires: "escalate" }];
		writeFileSync(join(d, "bank.json"), JSON.stringify(bank));
		expect(loadBank(d, { questions: "bank.json", thresholds: { default: 0.5, stuck: 0.7 } })).toEqual(bank as never);
		writeFileSync(join(d, "broken.json"), "[{");
		expect(() => loadBank(d, { questions: "broken.json", thresholds: { default: 0.5 } })).toThrow(
			"cannot read broken.json",
		);
		expect(() => loadBank(d, { questions: "missing.json", thresholds: { default: 0.5 } })).toThrow(
			"cannot read missing.json",
		);
		writeFileSync(join(d, "bad.json"), JSON.stringify([{ id: "x" }]));
		expect(() => loadBank(d, { questions: "bad.json", thresholds: { default: 0.5 } })).toThrow(
			'bad.json: question 1 (x) needs a non-empty "ask"',
		);
	});
	test("a threshold for a question the bank does not have is refused", () =>
		expect(() => loadBank(dir(), { questions: "default", thresholds: { default: 0.5, asks_decisoin: 0.6 } })).toThrow(
			'"asks_decisoin" is not a question in the bank',
		));
});
