import { describe, expect, test } from "bun:test";
import { parseAsk } from "./ask-parse.ts";
import { base, ID, inDays, mk, NOW, refuses } from "./testing/ask-fixtures.ts";

describe("proposedExpires on a question", () => {
	test("a future date or date-time is kept on the item", () => {
		expect(parseAsk({ ...base, proposedExpires: inDays(30) }, "Q-abc12", NOW).proposedExpires).toBe(inDays(30));
		const dt = new Date(Date.now() + 3_600_000).toISOString();
		expect(parseAsk({ ...base, proposedExpires: ` ${dt} ` }, "Q-abc12", NOW).proposedExpires).toBe(dt);
	});
	test("a question without one has none", () => {
		expect(parseAsk(base, "Q-abc12", NOW)).not.toHaveProperty("proposedExpires");
	});
	test("it needs a proposed ruling", () => {
		const { proposedRuling: _p, ...noRuling } = base;
		expect(() => parseAsk({ ...noRuling, proposedExpires: inDays(30) }, "Q-abc12", NOW)).toThrow(
			"proposedExpires needs a proposedRuling",
		);
	});
	test("an unreadable, zoneless, impossible or past value is refused", () => {
		for (const bad of ["next week", `${inDays(3)}T09:00:00`])
			expect(() => parseAsk({ ...base, proposedExpires: bad }, "Q-abc12", NOW)).toThrow(
				"proposedExpires must be an ISO date",
			);
		for (const bad of [
			"2026-02-30",
			"2099-02-30T09:00:00Z",
			"2099-02-29T09:00:00Z",
			"2099-13-01T09:00:00Z",
			"2099-11-13T24:00:00Z",
		])
			expect(() => parseAsk({ ...base, proposedExpires: bad }, "Q-abc12", NOW)).toThrow(
				`proposedExpires "${bad}" is not a real date and time`,
			);
		expect(parseAsk({ ...base, proposedExpires: "2096-02-29T09:00:00Z" }, "Q-abc12", NOW).proposedExpires).toBe(
			"2096-02-29T09:00:00Z",
		);
		expect(() => parseAsk({ ...base, proposedExpires: "2020-01-01" }, "Q-abc12", NOW)).toThrow(
			"proposedExpires is already past",
		);
		expect(() => parseAsk({ ...base, proposedExpires: 5 }, "Q-abc12", NOW)).toThrow("must be a string");
	});
});

describe("parseAsk: the fields", () => {
	test("anything that is not a JSON object is refused", () => {
		for (const raw of [null, undefined, "text", 5, 0])
			expect(() => parseAsk(raw, ID, NOW)).toThrow("ask: expected a JSON object");
	});
	test("a text field is trimmed; a required one that is absent, null or empty, or a field that is not text, is refused", () => {
		const q = mk({ title: "  Pick  ", context: " - a ", thread: " t ", server: " s ", kind: "idea" });
		expect([q.title, q.context, q.thread, q.server, q.kind]).toEqual(["Pick", "- a", "t", "s", "idea"]);
		for (const k of ["kind", "title", "thread", "server"])
			for (const v of [undefined, null, ""]) refuses({ [k]: v }, `ask: "${k}" is required`);
		refuses({ title: 5 }, 'ask: "title" must be a string');
		refuses({ thread: {} }, 'ask: "thread" must be a string');
		expect(mk({ context: undefined }).context).toBe("");
		expect(mk({ context: "" }).context).toBe("");
		refuses({ kind: "nope" }, /ask: kind must be one of/);
	});
	test("the optional fields are kept when given and left off when empty", () => {
		const bare = mk({});
		for (const k of ["threadId", "blocks", "tag", "secret", "urgent", "notSettled", "recommended", "evidence"])
			expect(bare).not.toHaveProperty(k);
		const full = mk({ threadId: " th ", blocks: " b ", tag: " Approval ", notSettled: " why ", recommended: 1 });
		expect([full.threadId, full.blocks, full.tag, full.notSettled, full.recommended]).toEqual([
			"th",
			"b",
			"Approval",
			"why",
			1,
		]);
		expect(full.createdAt).toBe(NOW);
		expect(full.id).toBe(ID);
		for (const k of ["threadId", "blocks", "tag", "notSettled"]) expect(mk({ [k]: "" })).not.toHaveProperty(k);
		expect(parseAsk(base, ID).createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
	});
});

describe("parseAsk: the options", () => {
	test("an option is a label or an object, and (Recommended) is stripped from the end of a label only", () => {
		const q = mk({
			options: [
				"A (Recommended)",
				{ label: "  B  (recommended) ", detail: " why " },
				{ label: "(Recommended) C" },
				{ label: "D", detail: 5 },
			],
		});
		expect(q.options).toEqual([
			{ label: "A" },
			{ label: "B", detail: "why" },
			{ label: "(Recommended) C" },
			{ label: "D" },
		]);
		expect(mk({ options: [{ label: "A", detail: "  " }, "B"] }).options[0]).toEqual({ label: "A" });
	});
	test("an option needs a label", () => {
		for (const bad of [{}, null, "", "  ", { label: 5 }, { label: " " }, 5, ["a"]])
			refuses({ options: [bad, "B"] }, "ask: option 1 needs a label");
		refuses({ options: ["A", {}] }, "ask: option 2 needs a label");
	});
	test("a route is thread or steward, and a thread route needs relay text and the item's threadId; a steward option keeps none", () => {
		const q = mk({
			threadId: "th",
			options: [
				{ label: "A", route: "thread", relay: " do it " },
				{ label: "B", route: "steward", relay: "ignored" },
				{ label: "C", route: null, relay: null },
				{ label: "D", relay: "ignored" },
			],
		});
		expect(q.options).toEqual([
			{ label: "A", route: "thread", relay: "do it" },
			{ label: "B" },
			{ label: "C" },
			{ label: "D" },
		]);
		refuses(
			{ options: [{ label: "A", route: "elsewhere" }, "B"] },
			'ask: option 1 route must be "thread" or "steward"',
		);
		refuses({ options: [{ label: "A", route: 5 }, "B"] }, 'ask: option 1 route must be "thread" or "steward"');
		refuses({ options: [{ label: "A", relay: 5 }, "B"] }, "ask: option 1 relay must be a string");
		refuses(
			{ options: ["A", { label: "B", route: "thread" }], threadId: "th" },
			"ask: option 2 routes to the thread, so it needs relay text",
		);
		refuses({ options: ["A", { label: "B", route: "thread", relay: "  " }], threadId: "th" }, "needs relay text");
		refuses(
			{ options: ["A", { label: "B", route: "thread", relay: "go" }] },
			"ask: an option routed to the thread needs the item's threadId",
		);
		refuses(
			{ options: ["A", { label: "B", route: "thread", relay: "go" }], threadId: "  " },
			"needs the item's threadId",
		);
	});
	test("two to nine options, or none for a secret", () => {
		refuses({ options: ["A"] }, "ask: give at least two options");
		refuses({ options: undefined }, "ask: give at least two options");
		refuses({ options: "A,B" }, "ask: give at least two options");
		expect(mk({ options: Array.from({ length: 9 }, (_, i) => `o${i}`) }).options).toHaveLength(9);
		refuses({ options: Array.from({ length: 10 }, (_, i) => `o${i}`) }, "ask: at most nine options (keys 1-9)");
		const secret = mk({ secret: true, options: [], threadId: "th" });
		expect([secret.options, secret.secret, secret.threadId]).toEqual([[], true, "th"]);
		refuses(
			{ secret: true, threadId: "th", options: Array.from({ length: 10 }, (_, i) => `o${i}`) },
			"at most nine options",
		);
		expect(mk({ secret: "yes", options: ["A", "B"] })).not.toHaveProperty("secret");
	});
	test("a secret with options is refused; file a non-secret choice first", () => {
		refuses(
			{ secret: true, threadId: "th", options: ["open intake", "defer"] },
			"ask: a secret question cannot have options; file a non-secret choice question first, then a secret request in its thread",
		);
		refuses(
			{ tag: "Secret", threadId: "th", options: ["A", "B"] },
			"ask: a secret question cannot have options; file a non-secret choice question first, then a secret request in its thread",
		);
		refuses(
			{ secret: true, threadId: "th", options: [{ label: "A", route: "thread", relay: "go" }, "B"] },
			"cannot have options",
		);
	});
	test("a secret without a threadId is refused", () => {
		refuses(
			{ secret: true, options: [] },
			"ask: a secret question needs a threadId; a secret is entered in its own thread",
		);
		refuses(
			{ tag: "Secret", options: [] },
			"ask: a secret question needs a threadId; a secret is entered in its own thread",
		);
		refuses({ secret: true, options: [], threadId: "  " }, "needs a threadId");
	});
	test("a valid secret (no options, with threadId) is accepted; a non-secret with options still is", () => {
		const secret = mk({ secret: true, options: [], threadId: "th-secret" });
		expect(secret).toMatchObject({ secret: true, options: [], threadId: "th-secret" });
		const byTag = mk({ tag: "Secret", options: [], threadId: "th-2" });
		expect(byTag).toMatchObject({ tag: "Secret", options: [], threadId: "th-2" });
		expect(byTag).not.toHaveProperty("secret");
		const choice = mk({ options: ["open intake", "defer"] });
		expect(choice.options.map((o) => o.label)).toEqual(["open intake", "defer"]);
		expect(choice).not.toHaveProperty("secret");
	});
	test("recommended is an option index from 0, or absent", () => {
		expect(mk({ recommended: 0 }).recommended).toBe(0);
		expect(mk({ recommended: 1 }).recommended).toBe(1);
		expect(mk({ recommended: null })).not.toHaveProperty("recommended");
		for (const bad of [-1, 2, 1.5, "1", true, Number.NaN])
			refuses({ recommended: bad }, "ask: recommended must be an option index from 0");
	});
});

describe("parseAsk: the evidence", () => {
	test("each entry is an image, video or link; a link needs an http(s) url and a file needs a path", () => {
		const q = mk({
			evidence: [
				{ type: "image", path: "/a.png", caption: "c" },
				{ type: "video", path: "/b.mp4", caption: 5 },
				{ type: "link", url: "https://x/y", caption: "" },
				{ type: "link", url: "http://x", path: "/p" },
				{ type: "image", path: "/c.png", url: "u" },
			],
		});
		expect(q.evidence).toEqual([
			{ type: "image", path: "/a.png", caption: "c" },
			{ type: "video", path: "/b.mp4", caption: "5" },
			{ type: "link", url: "https://x/y" },
			{ type: "link", path: "/p", url: "http://x" },
			{ type: "image", path: "/c.png", url: "u" },
		]);
		expect(mk({ evidence: [] })).not.toHaveProperty("evidence");
		expect(mk({ evidence: "x" })).not.toHaveProperty("evidence");
		for (const bad of [null, {}, { type: "audio" }, "image"])
			refuses({ evidence: [bad] }, "ask: evidence 1 needs type image, video or link");
		for (const bad of [{ type: "link" }, { type: "link", url: "ftp://x" }, { type: "link", url: 5 }])
			refuses({ evidence: [{ type: "image", path: "/a.png" }, bad] }, "ask: evidence 2 needs an http(s) url");
		for (const bad of [{ type: "image" }, { type: "video", path: "" }, { type: "image", path: 5 }])
			refuses({ evidence: [bad] }, "ask: evidence 1 needs a path");
	});
});

describe("parseAsk: urgency", () => {
	test("urgent must be true or false, and only false is kept", () => {
		refuses({ urgent: "no" }, 'ask: "urgent" must be true or false');
		refuses({ urgent: 0 }, 'ask: "urgent" must be true or false');
		expect(mk({ urgent: false }).urgent).toBe(false);
		expect(mk({ urgent: true })).not.toHaveProperty("urgent");
		refuses({ urgent: null }, 'ask: "urgent" must be true or false');
	});
	test("urgent: false on an approval or a secret is dropped, with a line saying which, and warns once", () => {
		const heard: string[] = [];
		const keep = (o: Record<string, unknown>) => parseAsk({ ...base, ...o }, ID, NOW, (l) => heard.push(l));
		for (const o of [
			{ tag: "Approval" },
			{ tag: "approval" },
			{ tag: "Secret", options: [], threadId: "th" },
			{ secret: true, options: [], threadId: "th" },
		])
			expect(keep({ ...o, urgent: false })).not.toHaveProperty("urgent");
		expect(heard).toEqual([
			'ask: "urgent": false ignored: an approval is always urgent, so it is filed and posted as urgent',
			'ask: "urgent": false ignored: an approval is always urgent, so it is filed and posted as urgent',
			'ask: "urgent": false ignored: a secret is always urgent, so it is filed and posted as urgent',
			'ask: "urgent": false ignored: a secret is always urgent, so it is filed and posted as urgent',
		]);
		heard.length = 0;
		expect(keep({ tag: "Other", urgent: false }).urgent).toBe(false);
		expect(keep({ tag: "Approval", urgent: true })).not.toHaveProperty("urgent");
		expect(keep({ tag: "Approval" })).not.toHaveProperty("urgent");
		expect(heard).toEqual([]);
	});
	test("without a warn function the note goes to stderr", () => {
		const seen: unknown[] = [];
		const was = console.error;
		console.error = (...a: unknown[]) => void seen.push(...a);
		try {
			parseAsk({ ...base, tag: "Approval", urgent: false }, ID, NOW);
		} finally {
			console.error = was;
		}
		expect(seen).toEqual([
			'ask: "urgent": false ignored: an approval is always urgent, so it is filed and posted as urgent',
		]);
	});
});
