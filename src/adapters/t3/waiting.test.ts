/**
 * The T3 side of the waiting-card mirror, driven through the page's aggregator (src/web/waiting.ts) the way the page uses
 * it: it shows question cards only, answers only where web.json grants a token, and drops a card answered in its thread.
 */

import { describe, expect, test } from "bun:test";
import { useAdaptersT3WaitingFixtures } from "../../testing/adapters-t3-waiting-fixtures.ts";
import { withAnswerRights } from "../../web/waiting.ts";
import { t3Linker } from "./links.ts";
import { redact } from "./ping.ts";
import { cardsFrom, mirrorId } from "./wait-cards.ts";
import type { Server } from "./wait-ctx.ts";

const { question, T, rig, swapped } = useAdaptersT3WaitingFixtures();

test("question cards and approvals are answerable; secrets and links are listed read-only; done or queue-tagged cards are left out", () => {
	const items = [
		question("r1"),
		{
			type: "approval_request",
			status: "waiting",
			requestId: "r2",
			requestKind: "command",
			prompt: "rm -rf build",
			reason: "clean",
		},
		{
			type: "secret_request",
			status: "waiting",
			requestId: "r3",
			label: "API key",
			reason: "deploy",
			placeholder: "sk-…",
		},
		{ type: "link_request", status: "waiting", requestId: "r4", url: "http://vps:3773", reason: "link the vps" },
		{ type: "approval_request", status: "completed", requestId: "r7" },
		question("r5", { status: "completed" }),
		question("r6", { questions: [{ id: "Steward [Q-abcd]", question: "x [Q-abcd]", options: [{ label: "A" }] }] }),
	];
	const cards = cardsFrom({ server: "main", canAnswer: true, thread: T, link: "t3-thread://v2/env/th-1" }, items);
	expect(cards.map((c) => [c.requestId, c.type, c.answerable])).toEqual([
		["r1", "question", true],
		["r2", "approval", true],
		["r3", "secret", false],
		["r4", "link", false],
	]);
	expect(cards[1]!.command).toBe("rm -rf build");
	expect(cards[1]!.question).toBe("command · clean");
	expect(cards[1]!.options.map((o) => o.label)).toEqual(["Approve once", "Decline"]);
	// #102: a secret mirror never carries the source card's label or reason.
	expect(cards[2]!.question).toBe("Secret request");
	expect(cards[2]!.question).not.toContain("API key");
	expect(cards[2]!.question).not.toContain("deploy");
	expect(cards[3]!.question).toBe("http://vps:3773 · link the vps");
	for (const r of cards.slice(2)) {
		expect(r.options).toEqual([]);
		expect(r.link).toBe("t3-thread://v2/env/th-1");
		expect(r.why).toBeTruthy();
	}
	const c = cards[0]!;
	expect(c.id).toBe(mirrorId("main", "r1"));
	expect(c.options).toEqual([{ label: "Approve" }, { label: "Hold", detail: "keep it held" }]);
	expect(c.recommended).toBe(0);
	expect(c.answerable).toBe(true);
	expect(c.threadTitle).toBe("Code improvements");
});

test("a card is read-only without the token, or when it asks several things, allows several picks, or wants text", () => {
	expect(cardsFrom({ server: "laptop", canAnswer: false, thread: T }, [question("r1")])[0]!.why).toBe(
		"answer it in its thread on laptop",
	);
	const two = question("r1", {
		questions: [question("x").questions[0], { id: "1", question: "and?", options: [{ label: "A" }] }],
	});
	expect(cardsFrom({ server: "main", canAnswer: true, thread: T }, [two])[0]!.answerable).toBe(false);
	const multi = question("r1", { questions: [{ ...question("x").questions[0], multiSelect: true }] });
	expect(cardsFrom({ server: "main", canAnswer: true, thread: T }, [multi])[0]!.answerable).toBe(false);
	const text = question("r1", { questions: [{ id: "0", question: "Why?", options: [] }] });
	expect(cardsFrom({ server: "main", canAnswer: true, thread: T }, [text])[0]!.answerable).toBe(false);
});

describe("a card's thread link", () => {
	const LAUNCHED = `mcp:launch:${"ab".repeat(32)}`;
	test("is the server's own T3 link, made from its environment, when the page names no prefix", async () => {
		const { m } = rig({ linker: t3Linker({ origin: "http://x", environmentId: "env-mac" }), threadId: LAUNCHED });
		await m.poll();
		expect(m.list()[0]!.link).toBe(`t3-thread://v2/env-mac/${LAUNCHED}`);
	});
	test("a slow environment read never delays the listing: the card lists at once without a link, and links once the read lands", async () => {
		let land: (v: { environmentId: string }) => void = () => {};
		const read = () => new Promise<{ environmentId: string }>((r) => (land = r));
		const { m } = rig({ linker: t3Linker({ origin: "http://x" }, { read: read as never }), threadId: LAUNCHED });
		const started = performance.now();
		await m.poll();
		expect(performance.now() - started).toBeLessThan(150);
		expect(m.list()).toHaveLength(1);
		expect(m.list()[0]!.link).toBeUndefined();
		land({ environmentId: "env-home" });
		await new Promise((r) => setTimeout(r, 0));
		await m.poll();
		expect(m.list()[0]!.link).toBe(`t3-thread://v2/env-home/${LAUNCHED}`);
	});
	test("is none when the environment can't be read: no link rather than a broken one", async () => {
		const read = async () => undefined;
		const { m } = rig({ linker: t3Linker({ origin: "http://x" }, { read }), threadId: LAUNCHED });
		await m.poll();
		await m.poll();
		expect(m.list()[0]!.link).toBeUndefined();
	});
	test("is none for a thread id T3 does not issue", async () => {
		const { m } = rig({ linker: t3Linker({ origin: "http://x", environmentId: "env-mac" }) });
		await m.poll();
		expect(m.list()[0]!.link).toBeUndefined();
	});
	test("a prefix the page names for the server (web.mirrorLinks) wins over the server's own link", async () => {
		const { m } = rig({
			linker: t3Linker({ origin: "http://x", environmentId: "env-mac" }),
			links: { main: "https://t3.example/env-x/" },
			threadId: LAUNCHED,
		});
		await m.poll();
		expect(m.list()[0]!.link).toBe(`https://t3.example/env-x/${LAUNCHED}`);
	});
});

test("poll lists the card, skips the Questions/Decisions threads, and answers it through the operate token", async () => {
	const { m, sent } = rig();
	await m.poll();
	expect(m.list().map((c) => c.requestId)).toEqual(["r1"]);
	expect(
		sent.some(
			(s) => s.payload?.threadId === "skipme" || s.payload?.threadId === "gone" || s.payload?.threadId === "idle",
		),
	).toBe(false);
	const { id, sig } = m.list()[0]!;
	const r = await m.answer(id, 0, sig);
	expect(r.status).toBe(200);
	const respond = sent.find((s) => s.tag === "orchestration.dispatchCommand")!;
	expect(respond.token).toBe("tok-op-token");
	expect(respond.payload).toMatchObject({
		type: "runtime-request.respond",
		threadId: "th-1",
		requestId: "r1",
		answers: { "0": "Approve (Recommended)" },
	});
	expect(m.list()).toHaveLength(0);
});

test("a card answered in its thread drops off at the next poll, and answering it from the page is refused", async () => {
	const { m, setItems, sent } = rig();
	await m.poll();
	const { id, sig } = m.list()[0]!;
	setItems(() => [question("r1", { status: "completed" })]);
	expect((await m.answer(id, 0, sig)).status).toBe(409);
	expect(sent.some((s) => s.tag === "orchestration.dispatchCommand")).toBe(false);
	await m.poll();
	expect(m.list()).toHaveLength(0);
});

test("a request that turned into something other than a question card is never answered", async () => {
	const { m, setItems, sent } = rig();
	await m.poll();
	const { id, sig } = m.list()[0]!;
	setItems(() => [{ type: "secret_request", status: "waiting", requestId: "r1" }]);
	expect((await m.answer(id, 0, sig)).status).toBe(409);
	expect(sent.some((s) => s.tag === "orchestration.dispatchCommand")).toBe(false);
});

test("without the operate token the card is listed read-only and can't be answered", async () => {
	const { m, sent } = rig({ operate: false });
	await m.poll();
	const c = m.list()[0]!;
	expect(c.answerable).toBe(false);
	expect((await m.answer(c.id, 0, c.sig)).status).toBe(403);
	expect(sent.some((s) => s.tag === "orchestration.dispatchCommand")).toBe(false);
});

test("a bad choice or unknown card is refused", async () => {
	const { m } = rig();
	await m.poll();
	const { id, sig } = m.list()[0]!;
	expect((await m.answer(id, 5, sig)).status).toBe(400);
	expect((await m.answer(id, "0", sig)).status).toBe(400);
	expect((await m.answer("C-000000000000", 0, sig)).status).toBe(404);
});

test("a question rewritten under the same request ID is refused, not answered", async () => {
	const { m, setItems, sent } = rig();
	await m.poll();
	const { id, sig } = m.list()[0]!;
	setItems(() => [swapped("r1", { id: "q2", question: "Delete the production database?" })]);
	expect((await m.answer(id, 0, sig)).status).toBe(409);
	expect(sent.some((s) => s.tag === "orchestration.dispatchCommand")).toBe(false);
});

test("options reversed after the view loaded are refused, both before and after the next poll", async () => {
	const { m, setItems, sent } = rig();
	await m.poll();
	const { id, sig } = m.list()[0]!;
	const reversed = () => [
		swapped("r1", {
			options: [
				{ label: "Hold", description: "keep it held" },
				{ label: "Approve (Recommended)", description: "Approve (Recommended)" },
			],
		}),
	];
	setItems(reversed);
	expect((await m.answer(id, 0, sig)).status).toBe(409);
	await m.poll();
	expect((await m.answer(id, 0, sig)).status).toBe(409);
	expect(sent.some((s) => s.tag === "orchestration.dispatchCommand")).toBe(false);
	const fresh = m.list()[0]!;
	expect((await m.answer(fresh.id, 0, fresh.sig)).status).toBe(200);
	expect(sent.find((s) => s.tag === "orchestration.dispatchCommand")!.payload.answers).toEqual({ "0": "Hold" });
});

test("a queue tag added to the live card makes it unanswerable here", async () => {
	const { m, setItems, sent } = rig();
	await m.poll();
	const { id, sig } = m.list()[0]!;
	setItems(() => [swapped("r1", { question: "Approve one more round? [Q-abcd]" })]);
	expect((await m.answer(id, 0, sig)).status).toBe(409);
	expect(sent.some((s) => s.tag === "orchestration.dispatchCommand")).toBe(false);
});

test("an answer without the fingerprint it was shown is refused", async () => {
	const { m } = rig();
	await m.poll();
	const { id } = m.list()[0]!;
	expect((await m.answer(id, 0, undefined)).status).toBe(409);
	expect((await m.answer(id, 0, "0000")).status).toBe(409);
});

test("a token never reaches the log or an error body", async () => {
	const { m, logs } = rig({ fail: (token) => `upstream failure ${token}` });
	await m.poll();
	expect(JSON.stringify(logs)).not.toContain("tok-read-token");
	expect(JSON.stringify(logs)).toContain("[redacted]");
	let fail = false;
	const r2 = rig({ fail: (token) => (fail ? `boom ${token}` : undefined) });
	await r2.m.poll();
	const { id, sig } = r2.m.list()[0]!;
	fail = true;
	const res = await r2.m.answer(id, 0, sig);
	expect(res.status).toBe(502);
	expect(JSON.stringify(res.body)).not.toContain("tok-op-token");
	expect(JSON.stringify(r2.logs)).not.toContain("tok-op-token");
	expect(redact("a SECRET b SECRET", ["SECRET", undefined])).toBe("a [redacted] b [redacted]");
});

test("only the server at the decisions server's origin gets answer rights", () => {
	const qs = { origin: "http://127.0.0.1:3773", operateTokenFile: "op" };
	const out = withAnswerRights(
		[
			{ name: "main", origin: "http://127.0.0.1:3773", tokenFile: "r" },
			{ name: "laptop", origin: "http://127.0.0.1:13774", tokenFile: "r", operateTokenFile: "laptop-op" },
			{ name: "main", origin: "http://evil:1", tokenFile: "r" },
		],
		qs,
	);
	expect(out.map((s) => s.operateTokenFile as string | null)).toEqual(["op", null, null]);
	expect(
		withAnswerRights([{ name: "main", origin: "http://127.0.0.1:3773", tokenFile: "r" }]).map(
			(s) => s.operateTokenFile as string | null,
		),
	).toEqual([null]);
});

test("other servers can answer only when web.json's answerTokens names them", () => {
	const qs = { origin: "http://127.0.0.1:3773", operateTokenFile: "op" };
	const list: Server[] = [
		{ name: "main", origin: "http://127.0.0.1:3773", tokenFile: "r" },
		{ name: "laptop", origin: "http://127.0.0.1:13774", tokenFile: "r", operateTokenFile: "from-servers-json" },
		{ name: "remote", origin: "http://127.0.0.1:13773", tokenFile: "r" },
		{ name: "other", origin: "http://x:1", tokenFile: "r", operateTokenFile: "sneaky" },
	];
	expect(
		withAnswerRights(list, qs, { laptop: "laptop-operate-token", remote: "remote-operate-token" }).map(
			(s) => s.operateTokenFile,
		),
	).toEqual(["op", "laptop-operate-token", "remote-operate-token", null]);
	expect(withAnswerRights(list, qs, { main: "x" } as Record<string, string>).map((s) => s.operateTokenFile)).toEqual([
		"op",
		null,
		null,
		null,
	]);
	expect(
		withAnswerRights(list, qs, JSON.parse('{"__proto__": "x", "constructor": "y"}')).map((s) => s.operateTokenFile),
	).toEqual(["op", null, null, null]);
});
