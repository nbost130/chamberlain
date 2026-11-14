/**
 * "Has the principal already settled this?" A new question (ask.ts) or hold (afk.ts hold) is checked against what was
 * decided before, so the same thing is never put to them twice. Three sources, all read from the Store:
 *   - answered decision-queue questions (items of source "queue" that are no longer open: the answer, its note, any ruling);
 *   - rulings in force now (a proposed ruling is not settled, nor is one that has expired, been superseded or been retired:
 *     the principal's word on it no longer stands, so the topic is open again);
 *   - the Steward's self-answers (the `decisions` table).
 *
 * The match is deterministic and every match says what it rests on. Precision comes first: a missed paraphrase costs one
 * question, a false match costs a `notSettled` override with a reason. In order:
 *   1. Exact refs that name ONE thing (strong): a commit SHA (7+ hex, with a digit and a letter), a run ID given as a
 *      field, a queue item ID in the title or --item. One shared strong ref is a match.
 *   2. Refs that name a SUBJECT (weak): a PR or issue number, a branch, a thread title (12+ characters, two words) that one
 *      side names inside the other's text. One PR gets a new gate question every round, so a weak ref matches only beside
 *      the same topic (sameTopic: three shared distinctive words, and half of the shorter title's).
 *   3. Title overlap (configurable, on by default): the new title against the settled title, ruling or decision. A
 *      two-word title must appear as one phrase (at most one word between) and carry a word that is not generic; a longer
 *      one needs three shared words, three quarters of the shorter side, two of them distinctive, and against a long text
 *      every shared word inside a narrow window.
 *
 * Configuration (settings.json `settledMatch`): `titleOverlap: false` turns rule 3 off (refs only); `ignoreWords` lists
 * words that head many unrelated questions in your setup (a product or project name) and so say nothing about the topic.
 * The principal's configured name is always ignored the same way. Records that cannot be read are skipped and named,
 * never silently.
 */
import { principal, readSettings, type SettledMatch } from "./config.ts";
import type { Clock } from "./rulings.ts";
import { decisionRecords, queueRecords, rulingRecords } from "./settled-records.ts";
import { names, sameTopic, titlesOverlap, tokens } from "./settled-title.ts";
import type { Store } from "./store.ts";

type SettledSource = "queue" | "ruling" | "decision";
export type Settled = {
	source: SettledSource;
	date: string;
	id: string;
	/** The answer, or what was decided, on one line. */
	answer: string;
	/** What the match rests on: "commit 1a2b3c4", "PR/issue o/r#12 + topic: billing, invoice, retry", "title overlap: rename, reeve". */
	why: string;
};
/** What is being asked or held. `title` is an ask's title or a hold's text; `context` only adds refs. */
export type Subject = {
	title: string;
	context?: string;
	thread?: string;
	item?: string;
	run?: string;
	pr?: string;
	issue?: string;
	branch?: string;
};

export type SettledRecord = {
	source: SettledSource;
	date: string;
	id: string;
	answer: string;
	title: string;
	text: string;
	thread?: string;
	run?: string;
	item?: string;
};

type PrRef = { repo?: string; n: number };
type Refs = { prs: PrRef[]; shas: string[]; items: string[]; runs: string[]; branches: string[] };

const SLUG = "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+";

/** Pure: the exact refs a text names. Fields (a run, a PR, a branch) are added by the caller. */
function refsIn(text: string): Refs {
	const prs: PrRef[] = [];
	for (const [, repo = "", n = ""] of text.matchAll(new RegExp(`(${SLUG})#(\\d{1,9})\\b`, "g")))
		prs.push({ repo: repo.toLowerCase(), n: Number(n) });
	// "app#962": a repo's name alone, which matches that repo under any owner.
	for (const [, repo = "", n = ""] of text.matchAll(/(?<![\w/.-])([A-Za-z][A-Za-z0-9_.-]*)#(\d{1,9})\b/g))
		prs.push({ repo: repo.toLowerCase(), n: Number(n) });
	for (const m of text.matchAll(/(?<![\w/&#])#(\d{1,9})\b/g)) prs.push({ n: Number(m[1]) });
	for (const m of text.matchAll(/\b(?:PRs?|pull(?: request)?s?|issues?)\s+#?(\d{1,6})\b/gi))
		prs.push({ n: Number(m[1]) });
	const uniq = prs.filter((p, i) => prs.findIndex((q) => q.n === p.n && q.repo === p.repo) === i);
	// A SHA has a digit and a letter, so a plain number or a word like "defaced" is not one.
	const shas = [...text.matchAll(/(?<![0-9A-Za-z])[0-9a-f]{7,40}(?![0-9A-Za-z])/g)]
		.map((m) => m[0])
		.filter((s) => /\d/.test(s) && /[a-f]/.test(s));
	const items = [...text.matchAll(/(?<![A-Za-z0-9-])(Q-[a-z0-9]{4,16})(?![A-Za-z0-9-])/g)].map(([, item = ""]) => item);
	const branches = [...text.matchAll(new RegExp(`(${SLUG}):([A-Za-z0-9_./-]{1,200})`, "g"))].map(
		([, repo = "", ref = ""]) => `${repo.toLowerCase()}:${ref}`,
	);
	return { prs: uniq, shas, items, runs: [], branches };
}

const refLabel = (p: PrRef) => `${p.repo ?? ""}#${p.n}`;
const repoName = (r: string) => r.slice(r.lastIndexOf("/") + 1);
const prMatch = (a: PrRef, b: PrRef) =>
	a.n === b.n &&
	(!a.repo ||
		!b.repo ||
		a.repo === b.repo ||
		((!a.repo.includes("/") || !b.repo.includes("/")) && repoName(a.repo) === repoName(b.repo)));

/** Pure: the refs both sides share, split into strong (one thing) and weak (a subject; needs the same topic too). */
function sharedRefs(a: Refs, aText: string, b: Refs, bText: string): { strong: string[]; weak: string[] } {
	const weak = [
		...a.prs.filter((p) => b.prs.some((q) => prMatch(p, q))).map((p) => `PR/issue ${refLabel(p)}`),
		...a.branches.filter((x) => b.branches.includes(x)).map((x) => `branch ${x}`),
	];
	const strong = [
		...a.shas.filter((s) => b.shas.some((t) => t.startsWith(s) || s.startsWith(t))).map((s) => `commit ${s}`),
		...a.items.filter((i) => b.items.includes(i)).map((i) => `item ${i}`),
		// A run ID comes from a field on one side and is found verbatim in the other's field or text.
		...a.runs.filter((r) => b.runs.includes(r) || bText.includes(r)).map((r) => `run ${r}`),
		...b.runs.filter((r) => !a.runs.includes(r) && aText.includes(r)).map((r) => `run ${r}`),
	];
	return { strong: [...new Set(strong)], weak: [...new Set(weak)] };
}

/* ---------- words ---------- */

/** The matching rule's settings: settings.json `settledMatch`, else the defaults (title overlap on, no extra ignored words). */
export function matchSettings(m: SettledMatch | undefined = readSettings().settledMatch): {
	titleOverlap: boolean;
	ignore: Set<string>;
} {
	// Case-insensitive: `tokens` lower-cases, so "ACME", "Acme" and "acme" ignore the same word.
	const ignore = new Set([...(m?.ignoreWords ?? []), principal()].flatMap((w) => tokens(String(w))));
	return { titleOverlap: m?.titleOverlap !== false, ignore };
}

/**
 * Everything already settled that this subject matches, newest first. A source that cannot be read, or a record that is
 * malformed, is skipped and named in `skipped`: a damaged record never blocks a question, and is never silent either.
 */
export function findSettled(
	store: Store,
	s: Subject,
	match: SettledMatch | undefined = readSettings().settledMatch,
	clock: Clock = Date.now,
): { matches: Settled[]; skipped: string[] } {
	const { titleOverlap, ignore } = matchSettings(match);
	const { records, skipped } = readRecords(store, clock());
	const body = `${s.title}\n${s.context ?? ""}`;
	const mine = subjectRefs(s, body);
	const matches: Settled[] = [];
	let malformed = 0;
	for (const r of records) {
		try {
			const why = whyMatches({ s, body, mine }, r, { titleOverlap, ignore });
			if (why) matches.push({ source: r.source, date: r.date, id: r.id, answer: r.answer, why });
		} catch {
			// EMPTY_CATCH_OK: one malformed record (a title that is not text, say) is counted below and never hides the others.
			malformed++;
		}
	}
	if (malformed) skipped.push(`${malformed} malformed record${malformed === 1 ? "" : "s"}`);
	matches.sort((a, b) => b.date.localeCompare(a.date));
	return { matches, skipped };
}

/** The records of the three sources; a source that cannot be read is named in `skipped` and the others still count. */
function readRecords(store: Store, nowMs: number): { records: SettledRecord[]; skipped: string[] } {
	const skipped: string[] = [];
	const records: SettledRecord[] = [];
	for (const [name, read] of [
		["questions", queueRecords],
		["rulings", (st: Store) => rulingRecords(st, nowMs)],
		["decisions", decisionRecords],
	] as const) {
		try {
			records.push(...read(store));
		} catch (e) {
			skipped.push(`${name} (${String(e instanceof Error ? e.message : e).slice(0, 60)})`);
		}
	}
	return { records, skipped };
}

/** The refs the subject names: those in its text, plus the PR, issue, item, run and branch it was given. */
function subjectRefs(s: Subject, body: string): Refs {
	const mine = refsIn(body);
	// A queue item named in the context is a pointer to earlier work, not this question: only the title and --item count.
	mine.items = refsIn(s.title).items;
	if (s.pr) mine.prs.push(...refsIn(s.pr).prs);
	if (s.issue) mine.prs.push(...refsIn(s.issue).prs);
	if (s.item) mine.items.push(s.item);
	if (s.run) mine.runs.push(s.run);
	if (s.branch) mine.branches.push(s.branch.toLowerCase());
	return mine;
}

/** What one record's match with the subject rests on, or undefined when it does not match. May throw on a malformed record. */
function whyMatches(
	{ s, body, mine }: { s: Subject; body: string; mine: Refs },
	r: SettledRecord,
	{ titleOverlap, ignore }: { titleOverlap: boolean; ignore: ReadonlySet<string> },
): string | undefined {
	const theirs = refsIn(r.text);
	theirs.items.push(r.id);
	if (r.item) theirs.items.push(r.item);
	if (r.run) theirs.runs.push(r.run);
	const { strong, weak } = sharedRefs(mine, body, theirs, r.text);
	if (names(body, r.thread) || names(r.text, s.thread)) weak.push("thread title");
	if (strong.length) return strong.slice(0, 3).join(", ");
	const topic = weak.length ? sameTopic(s.title, r.title, ignore) : undefined;
	if (topic) return `${weak.slice(0, 2).join(", ")} + topic: ${topic.slice(0, 4).join(", ")}`;
	const words = titleOverlap ? titlesOverlap(s.title, r.title, ignore) : undefined;
	return words ? `title overlap: ${words.slice(0, 5).join(", ")}` : undefined;
}

/** Pure: the refusal text, one line per match (at most ten) with what it rests on, then how to override. */
export function refusalLines(who: string, matches: Settled[], overrideHint: string): string[] {
	return [
		`${who}: refused, ${matches.length === 1 ? "this looks" : `${matches.length} records say this looks`} already settled. Do not ask or hold it again; act on the answer.`,
		...matches.slice(0, 10).map((m) => `  ${m.source} | ${m.date} | ${m.id} | ${m.answer} [matched on ${m.why}]`),
		...(matches.length > 10 ? [`  … and ${matches.length - 10} more`] : []),
		`If it is a different question, say why: ${overrideHint}`,
	];
}
