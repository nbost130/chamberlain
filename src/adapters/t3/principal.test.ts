import { describe, expect, test } from "bun:test";
import type { TurnItem } from "../../core/decide/decide.ts";
import { isPrincipalMessage, lastPrincipalWrite, readPrincipalLastWrite } from "./principal.ts";

const MIN = 60_000;
const NOW = Date.parse("2026-11-18T22:00:00.000Z");
const at = (agoMin: number) => new Date(NOW - agoMin * MIN).toISOString();
const msg = (source: string, agoMin: number, by = "user", text = "hi"): TurnItem => ({
	type: "user_message",
	id: `m-${source}-${agoMin}`,
	text,
	createdBy: by,
	creationSource: source,
	updatedAt: at(agoMin),
});
const tool = (agoMin: number): TurnItem => ({ type: "assistant_message", id: `a-${agoMin}`, updatedAt: at(agoMin) });

describe("who counts as the principal", () => {
	test("their own clients (mobile, web) do", () => {
		expect(isPrincipalMessage(msg("mobile", 1))).toBe(true);
		expect(isPrincipalMessage(msg("web", 1))).toBe(true);
	});
	test("the daemon's and the tools' posts as the principal (mcp, server, provider) do not, nor does an agent's message", () => {
		expect(isPrincipalMessage(msg("mcp", 1))).toBe(false);
		expect(isPrincipalMessage(msg("server", 1))).toBe(false);
		expect(isPrincipalMessage(msg("provider", 1))).toBe(false);
		expect(isPrincipalMessage(msg("mobile", 1, "agent"))).toBe(false);
		expect(isPrincipalMessage(tool(1))).toBe(false);
	});
	test("an unknown or missing source is not the principal's", () => {
		expect(isPrincipalMessage(msg("desktop", 1))).toBe(false);
		expect(isPrincipalMessage(msg("", 1))).toBe(false);
		const none: TurnItem = { type: "user_message", id: "x", createdBy: "user", updatedAt: at(1) };
		expect(isPrincipalMessage(none)).toBe(false);
		expect(lastPrincipalWrite([none, msg("desktop", 1)])).toBeUndefined();
	});
	test("the newest of several is the answer", () => {
		expect(lastPrincipalWrite([msg("mobile", 9), msg("web", 2), msg("mcp", 1)])).toBe(NOW - 2 * MIN);
		expect(lastPrincipalWrite([tool(1)])).toBeUndefined();
	});
});

const bounded = (items: TurnItem[], more = false, cursor: string | null = null) => ({
	projection: { turnItems: items },
	hasMoreHistory: more,
	historyCursor: cursor,
});
/** A get over canned answers, remembering the paths it was asked. */
const getOver =
	(answers: Record<string, unknown>, asked: string[] = []) =>
	async (path: string) => {
		asked.push(path);
		const a =
			answers[
				path.startsWith("/api/orchestration/threads/th/bounded") ? "bounded" : path.split("cursor=")[1]!.split("&")[0]!
			];
		if (!a) throw Error(`no answer for ${path}`);
		return a;
	};

describe("readPrincipalLastWrite", () => {
	const since = NOW - 5 * MIN;
	test("the principal's message inside the window is found in the first read", async () => {
		const get = getOver({ bounded: bounded([msg("mobile", 3), tool(1)]) });
		expect(await readPrincipalLastWrite("th", get, since)).toBe(NOW - 3 * MIN);
	});
	test("their last message is older than the window: not active", async () => {
		const get = getOver({ bounded: bounded([msg("mobile", 20), tool(1)]) });
		expect(await readPrincipalLastWrite("th", get, since)).toBeUndefined();
	});
	test("only machine messages and a thread with no more history: not active", async () => {
		const get = getOver({ bounded: bounded([msg("mcp", 1), msg("server", 2), tool(1)]) });
		expect(await readPrincipalLastWrite("th", get, since)).toBeUndefined();
	});
	test("a busy thread: the newest items are all tool output, so one history page is read for the message", async () => {
		const asked: string[] = [];
		const get = getOver(
			{
				bounded: bounded([tool(2), tool(1)], true, "c1"),
				c1: { items: [{ visibility: "local", item: msg("web", 4) }], hasMoreHistory: false, nextCursor: null },
			},
			asked,
		);
		expect(await readPrincipalLastWrite("th", get, since)).toBe(NOW - 4 * MIN);
		expect(asked).toHaveLength(2);
		expect(asked[1]).toContain("view=conversation");
	});
	test("it stops paging once the oldest item seen is older than the window", async () => {
		const asked: string[] = [];
		const get = getOver({ bounded: bounded([tool(8), tool(1)], true, "c1") }, asked);
		expect(await readPrincipalLastWrite("th", get, since)).toBeUndefined();
		expect(asked).toHaveLength(1);
	});
	test("a retained interrupt request does not stand for how far back the items reach", async () => {
		const old: TurnItem = { type: "run_interrupt_request", updatedAt: at(60) };
		const get = getOver({
			bounded: bounded([old, tool(2), tool(1)], true, "c1"),
			c1: { items: [{ visibility: "local", item: msg("mobile", 4) }], hasMoreHistory: false },
		});
		expect(await readPrincipalLastWrite("th", get, since)).toBe(NOW - 4 * MIN);
	});
	test("a parent's rows on a forked thread's page are not this thread's", async () => {
		const get = getOver({
			bounded: bounded([tool(1)], true, "c1"),
			c1: {
				items: [{ visibility: "inherited", sourceThreadId: "parent", item: msg("mobile", 2) }],
				hasMoreHistory: false,
			},
		});
		expect(await readPrincipalLastWrite("th", get, since)).toBeUndefined();
	});
	test("cannot tell: a malformed snapshot, a failed read, or a window never reached all throw", async () => {
		await expect(readPrincipalLastWrite("th", getOver({ bounded: {} }), since)).rejects.toThrow("turnItems");
		await expect(readPrincipalLastWrite("th", getOver({}), since)).rejects.toThrow();
		const endless = {
			bounded: bounded([tool(1)], true, "c1"),
			c1: { items: [{ visibility: "local", item: tool(1) }], hasMoreHistory: true, nextCursor: "c1" },
		};
		await expect(readPrincipalLastWrite("th", getOver(endless), since)).rejects.toThrow("did not reach back");
	});
});
