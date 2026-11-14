/** Branches of the T3 waiting-card adapter that waiting.test.ts reaches only through the page: reached here through the adapter itself. */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { cardsFrom, createT3Waiting, type Server, type WaitingDeps } from "./waiting.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** An adapter over a scripted socket: the shell stream gives `snapshot`, and only a read token exists unless `operate` is set. */
function adapter(snapshot: unknown, operate = false) {
	const conf = mkdtempSync(`${tmpdir()}/chamberlain-waiting-pins-`);
	dirs.push(conf);
	for (const f of ["read-token", ...(operate ? ["op-token"] : [])]) {
		writeFileSync(`${conf}/${f}`, `tok-${f}`);
		chmodSync(`${conf}/${f}`, 0o600);
	}
	const server: Server = { name: "main", origin: "http://x", tokenFile: "read-token", operateTokenFile: "op-token" };
	const sent: string[] = [];
	const connect = (async () => ({
		ws: { close() {} },
		call: async (_tag: string, _payload: unknown, onChunk?: (v: unknown) => void) => {
			onChunk?.({ kind: "snapshot", snapshot });
		},
		request: async (tag: string) => {
			sent.push(tag);
			return { turnItems: [] };
		},
	})) as unknown as WaitingDeps["connect"];
	return { sent, w: createT3Waiting({ server, conf, log: () => {}, connect, timeoutMs: 500 }) };
}

describe("the shell snapshot is checked before anything is listed", () => {
	test("a snapshot with no thread list, or a thread with no id, is refused rather than read as nothing waiting", async () => {
		for (const snapshot of [
			{},
			{ threads: "x" },
			{ threads: [{ id: "" }] },
			{ threads: [{ title: "no id" }] },
			{ threads: [null] },
		]) {
			const { w } = adapter(snapshot);
			await expect(w.listWaiting({ skipThreads: [] })).rejects.toThrow("malformed snapshot");
		}
	});
	test("a snapshot with an empty thread list lists nothing", async () => {
		const { w } = adapter({ threads: [] });
		expect(await w.listWaiting({ skipThreads: [] })).toEqual([]);
	});
});

describe("answer without an operate token", () => {
	test("is refused as 'refused', never sent, and says where to answer", async () => {
		const { w, sent } = adapter({ threads: [] });
		const card = cardsFrom("main", false, { id: "th-1" }, [
			{
				type: "user_input_request",
				status: "waiting",
				requestId: "r1",
				questions: [{ id: "0", question: "Q?", options: [{ label: "A" }] }],
			},
		])[0];
		expect(card).toBeDefined();
		if (!card) return;
		expect(await w.answer(card, 0, card.sig)).toEqual({
			ok: false,
			kind: "refused",
			error: "answer it in its thread on main",
			maybeSent: false,
		});
		expect(sent).toEqual([]);
	});
});

describe("an approval card", () => {
	test("carries the thread link it was given, and none when it was given none", () => {
		const item = { type: "approval_request", status: "waiting", requestId: "r1", prompt: "ls", requestKind: "command" };
		expect(cardsFrom("main", true, { id: "th-1" }, [item], "t3-thread://x/th-1")[0]?.link).toBe("t3-thread://x/th-1");
		expect("link" in (cardsFrom("main", true, { id: "th-1" }, [item])[0] ?? {})).toBe(false);
	});
});
