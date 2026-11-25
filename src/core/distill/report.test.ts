import { expect, test } from "bun:test";
import { mk } from "../../testing/ask-fixtures.ts";
import { useCoreMigrateFixtures } from "../../testing/core-migrate-fixtures.ts";
import { cfgWith } from "../../testing/overhead-fixtures.ts";
import { askQuestion, QUEUE } from "../items/questions.ts";
import { appendHeld, closeHeld } from "../ops/afk-held.ts";
import { openStore } from "../store/sqlite-store.ts";
import type { Store } from "../store/store.ts";
import { readDistillLedger } from "./ledger.ts";
import { distillReport, formatDistill } from "./report.ts";

const { world } = useCoreMigrateFixtures();
const span = { from: Date.parse("2026-06-01T00:00:00Z"), to: Date.parse("2026-06-08T00:00:00Z") };
const iso = (t: number) => new Date(t).toISOString();
const repo = "example/widget";
const text = "fixture text never disclosed";
const reportFor = async (seed: (store: Store) => void, options: Partial<Parameters<typeof distillReport>[0]> = {}) => {
	const { state } = world();
	const path = `${state}/fixture.db`;
	const store = openStore(path);
	try {
		seed(store);
	} finally {
		store.close();
	}
	return distillReport({
		span,
		ledger: readDistillLedger(path, span, options.config?.chat ?? false, "steward-fixture"),
		config: { timezone: "UTC", chat: false },
		github: cfgWith({ github: { repos: [repo], countRollups: true } }).github,
		gh: ghPage([pr(repo, 1), pr(repo, 2, "Rollup of 2 pull requests")]),
		...options,
	});
};

const pr = (r: string, n: number, t = "Change", merged = iso(span.from)) => ({
	r: `https://api.github.com/repos/${r}`,
	n,
	m: merged,
	t,
});
const ghPage = (items: ReturnType<typeof pr>[]) => async () => ({ total: items.length, incomplete: false, items });

function card(store: Store, n: number, extra: Record<string, unknown> = {}, asked = span.from) {
	const id = `Q-fixture${n}`;
	const q = { ...mk({ repo, recommended: 0, title: "test card", thread: "example thread", ...extra }), id };
	askQuestion(store, q, asked);
	return id;
}

function answer(store: Store, id: string, fields: Record<string, unknown>, at = span.from) {
	const t = iso(at);
	store.claims.claim(QUEUE, {
		item: id,
		owner: "page",
		deliveryId: id,
		message: text,
		t,
		answer: { choice: 1, label: text, t, ...fields },
	});
}

function cite(store: Store, thread: string, rulingIds: string[], at = span.from) {
	store.decisions.append({ t: iso(at), thread, decision: text, ruling: text, ref: null, rulingIds });
}

test("counts asked cards and answer types at their own timestamps, with rollups out and no title filter", async () => {
	const r = await reportFor((s) => {
		answer(s, card(s, 1), {});
		answer(s, card(s, 2, {}, span.from - 1), { choice: -1, kind: "direction", note: text });
		answer(s, card(s, 3), { choice: 0 });
		answer(s, card(s, 4), { choice: -1, kind: "dismissed", note: text });
		answer(s, card(s, 5), { note: text });
		answer(s, card(s, 6, { recommended: undefined }), { choice: -1, kind: "direction", note: text });
		answer(s, card(s, 7), {}, span.to);
		const snoozed = card(s, 8, {}, span.from - 1);
		s.events.append({ t: iso(span.from), event: "snoozed", id: snoozed });
		s.events.append({ t: iso(span.from + 1), event: "snoozed", id: snoozed });
		answer(s, snoozed, {}, span.to);
		card(s, 9, { options: [], recommended: undefined, secret: true, threadId: "fixture-source", title: text });
		card(s, 10, {}, span.to);
		const legacy = card(s, 11, {}, span.from - 1);
		s.items.patch(QUEUE, legacy, { snoozedAt: iso(span.from) });
		card(s, 12, { recommended: undefined });
	});
	expect(r).toMatchObject({
		escalations: 8,
		corrections: 2,
		changedPicks: 1,
		directions: 1,
		acceptedPicks: 1,
		dismissals: 1,
		picksWithNote: 1,
		noRecommendation: 3,
		snoozes: 2,
		unplaced: 0,
		mergedPrs: 1,
		escalationsPerPr: 8,
		correctionsPerPr: 2,
		chatStatus: "off",
	});
	expect(JSON.stringify(r)).not.toContain(text);
	expect(formatDistill(r)).not.toContain(text);
});

test("attributes one correction per cited ruling and same thread in the interval", async () => {
	const r = await reportFor((s) => {
		answer(s, card(s, 1, { threadId: "thread-fixture" }), {});
		cite(s, "thread-fixture", ["R1", "R1", "R2", text]);
		cite(s, "example thread", ["R1", "R3"]);
		cite(s, "thread-fixture", ["R4"], span.from - 1);
		cite(s, "thread-fixture", ["R5"], span.to);
		cite(s, "other thread", ["R6"]);
	});
	expect(r.correctionsByRuling).toEqual({ R1: 1, R2: 1, R3: 1 });
});

test("a shared thread title cannot attribute one thread's ruling to another", async () => {
	const r = await reportFor((s) => {
		answer(s, card(s, 1, { threadId: "fixture-a" }), {});
		card(s, 2, { threadId: "fixture-b" });
		cite(s, "example thread", ["R1"]);
		cite(s, "fixture-a", ["R2"]);
	});
	expect(r.correctionsByRuling).toEqual({ R2: 1 });
});

test("cards that do not say which thread they came from share no ruling by name", async () => {
	const both = await reportFor((s) => {
		answer(s, card(s, 1), {});
		answer(s, card(s, 2), {});
		cite(s, "example thread", ["R1"]);
	});
	expect(both.corrections).toBe(2);
	expect(both.correctionsByRuling).toEqual({});
	const mixed = await reportFor((s) => {
		answer(s, card(s, 1, { threadId: "fixture-a" }), {});
		card(s, 2);
		cite(s, "example thread", ["R1"]);
	});
	expect(mixed.correctionsByRuling).toEqual({});
});

test("prefers validated explicit scope, then closed and open PR/issue holds linked by card", async () => {
	const r = await reportFor(
		(s) => {
			const explicit = card(s, 1, { repo: repo.toUpperCase() });
			appendHeld(s, { item: explicit, thread: "example thread", what: "different", ref: { issue: "example/other#5" } });
			const legacy = card(s, 2, { repo: undefined });
			const opened = appendHeld(s, { item: legacy, thread: "example thread", what: "old", ref: { pr: `${repo}#2` } });
			closeHeld(s, opened, "complete");
			const issue = card(s, 3, { repo: undefined });
			appendHeld(s, { item: issue, thread: "example thread", what: "new", ref: { issue: `${repo}#3` } });
		},
		{ gh: ghPage([pr(repo, 1), pr(repo, 2, "Later", iso(span.to))]) },
	);
	expect(r).toMatchObject({ unplaced: 0, outOfScope: 0, escalationsPerPr: 3, correctionsPerPr: 0 });
});

test("with cards unplaced a ratio is a lower bound under its own name, never an exact one", async () => {
	const r = await reportFor((s) => {
		answer(s, card(s, 1), {});
		answer(s, card(s, 2, { repo: "example/other" }), {});
		answer(s, card(s, 3, { repo: undefined, context: "example/widget#2" }), {});
		const ambiguous = card(s, 4, { repo: undefined });
		appendHeld(s, {
			item: ambiguous,
			thread: "example thread",
			what: "conflict",
			ref: { pr: `${repo}#1`, issue: "example/other#3" },
		});
	});
	expect(r).toMatchObject({
		escalations: 4,
		corrections: 3,
		unplaced: 2,
		outOfScope: 1,
		scopedEscalations: 1,
		unplacedEscalations: 2,
		scopedCorrections: 1,
		unplacedCorrections: 1,
		escalationsPerPrAtLeast: 1,
		correctionsPerPrAtLeast: 1,
	});
	expect(r).not.toHaveProperty("escalationsPerPr");
	expect(r).not.toHaveProperty("correctionsPerPr");
	const shown = formatDistill(r);
	expect(shown).toContain("Unplaced cards: 2 · cards outside the PR scope: 1");
	expect(shown).toContain(
		"escalations at least 1 over 1 (1 of 4 placed) · corrections at least 1 over 1 (1 of 3 placed)",
	);
});

test("an owner is a scope, an excluded repository is not, and names compare without case", async () => {
	const r = await reportFor(
		(s) => {
			card(s, 1);
			card(s, 2, { repo: "example/private" });
			card(s, 3, { repo: "examples/widget" });
		},
		{
			github: cfgWith({ github: { owners: ["Example"], excludeRepos: ["Example/Private"] } }).github,
			gh: ghPage([pr("Example/Widget", 1), pr("example/private", 2)]),
		},
	);
	expect(r).toMatchObject({ mergedPrs: 1, outOfScope: 2, scopedEscalations: 1, escalationsPerPr: 1 });
});

test("each figure is zero only when its own cards are placed, and unknown otherwise", async () => {
	const other = (s: Store) => card(s, 1, { repo: "example/other" });
	expect(await reportFor(other)).toMatchObject({ outOfScope: 1, escalationsPerPr: 0, correctionsPerPr: 0 });
	const asked = await reportFor((s) => {
		answer(s, card(s, 1, {}, span.from - 1), {});
		card(s, 2, { repo: undefined });
	});
	expect(asked).toMatchObject({ escalations: 1, scopedEscalations: 0, unplacedEscalations: 1, correctionsPerPr: 1 });
	expect(asked).not.toHaveProperty("escalationsPerPr");
	expect(asked).not.toHaveProperty("escalationsPerPrAtLeast");
	expect(formatDistill(asked)).toContain("escalations unknown · corrections 1.00");
	const corrected = await reportFor((s) => {
		card(s, 1);
		answer(s, card(s, 2, { repo: undefined }, span.from - 1), {});
	});
	expect(corrected).toMatchObject({ escalationsPerPr: 1, unplacedCorrections: 1 });
	expect(corrected).not.toHaveProperty("correctionsPerPr");
	expect(formatDistill(corrected)).toContain("escalations 1.00 · corrections unknown");
	const partly = await reportFor((s) => {
		answer(s, card(s, 1, {}, span.from - 1), {});
		answer(s, card(s, 2, { repo: undefined }, span.from - 1), {});
	});
	expect(partly).toMatchObject({ escalationsPerPr: 0, correctionsPerPrAtLeast: 1 });
	expect(formatDistill(partly)).toContain("escalations 0.00 · corrections at least 1 over 1 (1 of 2 placed)");
});

test("a lower bound is never rounded to zero or past what was counted", async () => {
	const prs = Array.from({ length: 201 }, (_, i) => pr(repo, i + 1));
	const pages = async (path: string) => {
		const from = (Number(new URLSearchParams(path.split("?")[1]).get("page")) - 1) * 100;
		return { total: prs.length, incomplete: false, items: prs.slice(from, from + 100) };
	};
	const r = await reportFor(
		(s) => {
			card(s, 1);
			card(s, 2, { repo: undefined });
		},
		{ gh: pages },
	);
	expect(r.escalationsPerPrAtLeast).toBeCloseTo(1 / 201, 10);
	expect(formatDistill(r)).toContain("escalations at least 1 over 201 (1 of 2 placed)");
});

test("a PR outside the scope, zero PRs, partial PRs and absent config never print ratios", async () => {
	for (const [options, expected] of [
		[{ gh: ghPage([pr("example/other", 1)]) }, { mergedPrs: null, prStatus: "unavailable" }],
		[{ gh: ghPage([]) }, { mergedPrs: 0, prStatus: "ok" }],
		[
			{ gh: async () => ({ total: 2, incomplete: false, items: [pr(repo, 1)] }) },
			{ mergedPrs: null, prStatus: "unavailable" },
		],
		[{ github: cfgWith({ github: {} }).github }, { mergedPrs: null, prStatus: "not configured" }],
	] as const) {
		const r = await reportFor((s) => card(s, 1), options);
		expect(r).toMatchObject(expected);
		expect(formatDistill(r)).not.toContain("Per merged PR:");
		expect(r).not.toHaveProperty("escalationsPerPr");
		expect(r).not.toHaveProperty("correctionsPerPr");
	}
});

test("chat is off by default, optional, aggregate-only, and reports failures as unavailable", async () => {
	const chat = { timezone: "UTC", chat: true };
	const seed = (s: Store) => {
		answer(s, card(s, 1), {});
		s.steward.insertGen({ gen: 1, thread: "steward-first", wakeRef: "fixture-ref", createdAt: span.from - 1 });
		s.steward.insertGen({ gen: 2, thread: "steward-second", wakeRef: "fixture-ref", createdAt: span.from + 1 });
	};
	const called: unknown[] = [];
	const readChat = async (period: unknown) => {
		called.push(period);
		return 2;
	};
	expect(await reportFor(seed, { readChat })).toMatchObject({ chatStatus: "off", corrections: 1 });
	expect(called).toEqual([]);
	expect(await reportFor(seed, { config: chat, readChat })).toMatchObject({ chatRedirections: 4, corrections: 1 });
	expect(called).toEqual([
		{ thread: "steward-first", from: span.from, to: span.from + 1 },
		{ thread: "steward-second", from: span.from + 1, to: span.to },
	]);
	expect(await reportFor(seed, { config: chat })).toMatchObject({ chatStatus: "unavailable" });
	const failed = await reportFor(seed, {
		config: chat,
		readChat: async () => {
			throw Error(text);
		},
	});
	expect(failed.chatStatus).toBe("unavailable");
	expect(JSON.stringify(failed)).not.toContain(text);
	expect(formatDistill(failed)).not.toContain(text);
});
