/**
 * The queue API never returns a secret item's title, context, evidence or options (#102): view() redacts them
 * server-side so the Decisions view and the full page share one door.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import type { WaitingCard } from "../core/adapter/adapter-waiting.ts";
import { holdCard } from "../core/items/card-hold.ts";
import { askQuestion, type QuestionState } from "../core/items/questions.ts";
import { SECRET_TITLE } from "../core/items/secret-fields.ts";
import { useWebCapabilityFixtures } from "../testing/web-capability-fixtures.ts";
import { cardView, view } from "./app-ctx.ts";

const { ORIGIN, setup, key } = useWebCapabilityFixtures();

const TITLE = "SYNTH-VIEW-SECRET-TITLE";
const CONTEXT = "SYNTH-VIEW-SECRET-CONTEXT";
const DETAILS = "SYNTH-VIEW-SECRET-DETAILS";
const CAPTION = "SYNTH-VIEW-SECRET-EVIDENCE";
const OPTION = "SYNTH-VIEW-SECRET-OPTION";
const LABEL = "SYNTH-CARD-SECRET-LABEL";

const asState = (over: Partial<QuestionState> & { id: string }): QuestionState =>
	({
		kind: "only-you",
		title: TITLE,
		context: CONTEXT,
		details: DETAILS,
		options: [{ label: OPTION }],
		evidence: [{ type: "image", path: "shot.png", caption: CAPTION }],
		secret: true,
		thread: "Launch thread",
		server: "main",
		threadId: "thread-1",
		createdAt: "2026-11-14T08:00:00.000Z",
		status: "open",
		...over,
	}) as QuestionState;

describe("view() redacts secrets (#102)", () => {
	test("title, context, evidence and options become stand-ins; the synthetic strings are gone", () => {
		const out = view({} as never, asState({ id: "Q-secr" }));
		expect(out).toMatchObject({ secret: true, title: SECRET_TITLE, context: "", options: [] });
		expect(out.evidence).toBeUndefined();
		expect(out).not.toHaveProperty("details");
		expect(JSON.stringify(out)).not.toContain("SYNTH-VIEW-SECRET");
	});
});

describe("cardView redacts mirrored secrets (#102)", () => {
	test("a secret card's label and reason never leave cardView", () => {
		const card: WaitingCard = {
			id: "C-aaaaaaaaaaaa",
			type: "secret",
			server: "main",
			threadId: "th-1",
			threadTitle: "Launch",
			requestId: "req-1",
			header: "Secret request",
			question: "SYNTH-MIRROR-LABEL · SYNTH-MIRROR-REASON",
			options: [],
			answerable: false,
			why: "enter it in its thread; secrets are never entered here",
			sig: "sig",
		};
		const out = cardView({} as never, card);
		expect(out.question).toBe(SECRET_TITLE);
		expect(JSON.stringify(out)).not.toContain("SYNTH-MIRROR");
	});
});

describe("the queue API redacts secrets (#102)", () => {
	test("a secret item's title, context, evidence and options never appear in /api/queue or /api/items", async () => {
		const s = setup();
		mkdirSync(`${s.state}/evidence/Q-secr`, { recursive: true });
		writeFileSync(`${s.state}/evidence/Q-secr/shot.png`, "SECRETBYTES");
		askQuestion(s.store, {
			id: "Q-secr",
			kind: "only-you",
			title: TITLE,
			context: CONTEXT,
			options: [{ label: OPTION }],
			evidence: [{ type: "image", path: "shot.png", caption: CAPTION }],
			secret: true,
			thread: "Launch thread",
			server: "main",
			threadId: "thread-1",
			createdAt: "2026-11-14T08:00:00.000Z",
		});
		const body = await (await s.get("/api/queue", key(s.token))).json();
		const item = body.items.find((i: { id: string }) => i.id === "Q-secr");
		expect(item).toMatchObject({ secret: true, title: SECRET_TITLE, context: "", options: [] });
		expect(item.evidence).toBeUndefined();
		const dumped = JSON.stringify(body);
		expect(dumped).not.toContain(TITLE);
		expect(dumped).not.toContain(CONTEXT);
		expect(dumped).not.toContain(CAPTION);
		expect(dumped).not.toContain(OPTION);
		expect(JSON.stringify(await (await s.get("/api/items/Q-secr", key(s.token))).json())).not.toContain(TITLE);
		// File is on disk and listed; a secret still gets 404 (a non-secret Q-evid with the same layout is 200).
		expect(
			(await s.get("/evidence/Q-evid/shot.png", { origin: ORIGIN, "sec-fetch-site": "same-origin", ...key(s.token) }))
				.status,
		).toBe(200);
		expect(
			(await s.get("/evidence/Q-secr/shot.png", { origin: ORIGIN, "sec-fetch-site": "same-origin", ...key(s.token) }))
				.status,
		).toBe(404);
	});

	test("a daemon secret pointer's options and card label never appear in the queue API", async () => {
		const s = setup();
		const { item: id } = holdCard(s.store, {
			thread: "Launch thread",
			server: "main",
			threadId: "th-secret",
			requestId: "req-synth-secret",
			type: "secret_request",
			label: LABEL,
		});
		const body = await (await s.get("/api/queue", key(s.token))).json();
		const item = body.items.find((i: { id: string }) => i.id === id);
		expect(item).toMatchObject({ secret: true, title: SECRET_TITLE, options: [], context: "" });
		expect(JSON.stringify(body)).not.toContain(LABEL);
		expect(JSON.stringify(body)).not.toContain("Open the question card");
	});
});
