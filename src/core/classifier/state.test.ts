import { describe, expect, test } from "bun:test";
import {
	buildState,
	type HookRunner,
	parseHookOutput,
	redactText,
	runRedactHook,
	type SentState,
	sentChars,
	tail,
	type ThreadText,
} from "./state.ts";

const SEND = { lastChars: 1500, previousChars: 400, title: true };
const thread = (over: Partial<ThreadText> = {}): ThreadText => ({
	title: "Fix the gate",
	lastMessage: "All done. Say go and I'll merge it.",
	previous: { from: "human", text: "is it done?" },
	...over,
});

describe("the built-in redaction", () => {
	test("replaces emails, API keys and tokens, JWTs, phone numbers and home-directory user names, and counts them", () => {
		const secret = ["sk", "-", "a".repeat(24)].join("");
		const gh = ["ghp", "_", "B".repeat(30)].join("");
		const jwt = ["eyJ", "x".repeat(12), ".", "y".repeat(12), ".", "z".repeat(12)].join("");
		const r = redactText(
			`mail ops@example.com key ${secret} gh ${gh} aws AKIA${"Q".repeat(16)} jwt ${jwt} call 919-555-0134 at /Users/someone/dev and /home/other/x`,
		);
		expect(r.text).toBe("mail <email> key <secret> gh <secret> aws <secret> jwt <jwt> call <phone> at ~/dev and ~/x");
		expect(r.hits).toBe(8);
	});
	test("plain prose is untouched", () =>
		expect(redactText("Merged #12; CI is green.")).toEqual({ text: "Merged #12; CI is green.", hits: 0 }));
});

describe("buildState: exactly what leaves the machine", () => {
	test("title, the tail of the last message, the tail of the previous one with only its author's kind", () => {
		const long = `${"x".repeat(3000)} THE END`;
		const b = buildState(
			thread({ lastMessage: long, previous: { from: "agent", text: `${"p".repeat(900)}?` } }),
			SEND,
			true,
		);
		expect(b.state.thread_title).toBe("Fix the gate");
		expect(b.state.last_message).toHaveLength(1500);
		expect(b.state.last_message.endsWith(" THE END")).toBe(true);
		expect(b.state.previous_message).toEqual({ from: "agent", text: `${"p".repeat(399)}?` });
		expect(Object.keys(b.state).sort()).toEqual(["last_message", "previous_message", "thread_title"]);
		expect(b.sentChars).toBe(12 + 1500 + 400);
		expect(sentChars(b.state)).toBe(b.sentChars);
	});
	test("send.title false leaves the title out; no previous message sends an empty one labelled none", () => {
		const b = buildState(thread({ previous: { from: "none", text: "" } }), { ...SEND, title: false }, true);
		expect("thread_title" in b.state).toBe(false);
		expect(b.state.previous_message).toEqual({ from: "none", text: "" });
	});
	test("a cut through an emoji never leaves a lone surrogate (Jev answers HTTP 400 to one)", () => {
		// "🙂" is two UTF-16 units; a cut of 3 from the end of "a🙂bc" keeps the low half only.
		expect("a🙂bc".slice(-3).isWellFormed()).toBe(false);
		expect(tail("a🙂bc", 3).isWellFormed()).toBe(true);
		const b = buildState(
			thread({ lastMessage: `x🙂${"y".repeat(10)}`, title: "🙂".repeat(150) }),
			{ ...SEND, lastChars: 11 },
			true,
		);
		for (const s of [b.state.last_message, b.state.thread_title!, b.state.previous_message.text])
			expect(s.isWellFormed()).toBe(true);
	});
	test("redaction sees past the cut, so a secret straddling it is still replaced", () => {
		const secret = ["sk", "-", "k".repeat(40)].join("");
		const b = buildState(thread({ lastMessage: `${secret} tail` }), { ...SEND, lastChars: 20 }, true);
		expect(b.state.last_message).toBe("<secret> tail");
		expect(b.redactions).toBe(1);
		// With the built-in redaction off, the raw tail goes.
		const raw = buildState(thread({ lastMessage: `${secret} tail` }), { ...SEND, lastChars: 20 }, false);
		expect(raw.state.last_message).toBe(`${"k".repeat(15)} tail`);
		expect(raw.redactions).toBe(0);
	});
	test("previousChars 0 sends no previous text, but still says who wrote it", () =>
		expect(buildState(thread(), { ...SEND, previousChars: 0 }, true).state.previous_message).toEqual({
			from: "human",
			text: "",
		}));
});

describe("the redaction hook fails closed", () => {
	const given: SentState = { thread_title: "T", previous_message: { from: "human", text: "q" }, last_message: "a b" };
	const runner =
		(
			r: { code: number | null; stdout: string } | Error,
			seen: { argv?: string[]; stdin?: string; ms?: number } = {},
		): HookRunner =>
		async (argv, stdin, ms) => {
			Object.assign(seen, { argv, stdin, ms });
			if (r instanceof Error) throw r;
			return r;
		};
	test("it gets the state as JSON on stdin and its output replaces it", async () => {
		const seen: { argv?: string[]; stdin?: string; ms?: number } = {};
		const out = { ...given, last_message: "a [x]" };
		expect(
			await runRedactHook(["/bin/redact", "-q"], given, runner({ code: 0, stdout: JSON.stringify(out) }, seen)),
		).toEqual(out);
		expect(seen).toEqual({ argv: ["/bin/redact", "-q"], stdin: JSON.stringify(given), ms: 5000 });
	});
	test("a failure, a timeout, non-JSON or another shape throws: nothing may be sent", async () => {
		const cases: [Parameters<typeof runner>[0], string][] = [
			[Error("ENOENT"), "could not be run"],
			[{ code: 3, stdout: "" }, "exited 3"],
			[{ code: null, stdout: "" }, "timed out"],
			[{ code: 0, stdout: "redacted!" }, "not JSON"],
			[{ code: 0, stdout: JSON.stringify({ last_message: "x" }) }, "not the state"],
			[{ code: 0, stdout: JSON.stringify({ ...given, extra: 1 }) }, "not the state"],
			[{ code: 0, stdout: JSON.stringify({ ...given, last_message: 5 }) }, "not the state"],
			// The hook may not relabel who wrote the previous message.
			[
				{ code: 0, stdout: JSON.stringify({ ...given, previous_message: { from: "agent", text: "q" } }) },
				"not the state",
			],
		];
		for (const [r, msg] of cases) await expect(runRedactHook(["/bin/r"], given, runner(r))).rejects.toThrow(msg);
	});
	test("its output is made well formed too", () =>
		expect(
			parseHookOutput(JSON.stringify({ ...given, last_message: "x\uD800" }), given).last_message.isWellFormed(),
		).toBe(true));
	test("the real spawn: a hook that reads stdin and prints it back", async () =>
		expect(await runRedactHook(["/bin/cat"], given)).toEqual(given));
	test("the real spawn: a hook that hangs is cut off at the timeout", async () =>
		expect(runRedactHook(["/bin/sleep", "5"], given, undefined, 200)).rejects.toThrow("timed out"));
});
