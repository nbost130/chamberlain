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
import { type QuestionState, questionStates } from "./questions.ts";
import { type Clock, readRulings } from "./rulings.ts";
import { isExpired } from "./rulings-expiry.ts";
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

type SettledRecord = {
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

const oneLine = (s: string, n = 110) => {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/* ---------- refs ---------- */

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

const STOP = new Set(
	"the and for with from this that these those into onto over under about after before while than then them they their there here have has had been being are was were will would should could can may might must not but you your his her its our out off per via who whom what when where which why how all any each some more most other such only own same too very just also now new old one two get got let use used using need needs want wants make made going goes done did does doing is it as at be by do if in of on or so to up we an a".split(
		" ",
	),
);
/** Workflow words that open many unrelated questions. A title made only of these never matches on overlap. */
const GENERIC = new Set(
	"approve approval approved deploy deployed deployment merge merged review reviewed decision decide decided question ask asks asked fix fixed fixes pr issue release released delete deleted remove removed ready green red check checks run runs thread threads item items update updated add added change changes changed hold held wait waiting needs needed confirm confirmed yes no ok pick choose call plan test tests build builds work worker workers task tasks gate gates".split(
		" ",
	),
);

/** Pure: a title's significant words, in order, lightly stemmed (a plural "s" dropped). */
export function tokens(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
		if (raw.length < 3 || STOP.has(raw)) continue;
		const w = raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw;
		if (out[out.length - 1] !== w) out.push(w);
	}
	return out;
}

/**
 * Pure: the shared words when two titles overlap strongly enough to be the same question, else undefined. `ignore` are words
 * that say nothing about the topic (settings `ignoreWords`, the principal's name, lower-cased by `matchSettings`): they are
 * dropped from both titles before any count, so "Acme deployment" and "Acme deployment database rollback?" share one word.
 */
export function titlesOverlap(x: string, y: string, ignore: ReadonlySet<string> = new Set()): string[] | undefined {
	const tx = dropIgnored(tokens(x), ignore),
		ty = dropIgnored(tokens(y), ignore);
	const [a, b] = new Set(tx).size <= new Set(ty).size ? [tx, ty] : [ty, tx];
	const aSet = new Set(a),
		bSet = new Set(b);
	if (aSet.size < 2) return undefined;
	const shared = [...aSet].filter((w) => bSet.has(w));
	const distinctive = shared.filter((w) => !GENERIC.has(w));
	if (aSet.size === 2) return pairOverlap(a, b, bSet.size, shared, distinctive);
	if (shared.length < 3 || shared.length / aSet.size < 0.75 || distinctive.length < 2) return undefined;
	if (bSet.size <= 2 * aSet.size) return shared;
	// Against a long text every shared word must sit close together, or any long ruling would "contain" a short title.
	if (shared.length !== aSet.size) return undefined;
	return sitTogether(b, new Set(shared), 2 * aSet.size + 2) ? shared : undefined;
}

/** Pure: a title's words without the ignored ones and without a word repeated right after itself. */
const dropIgnored = (t: string[], ignore: ReadonlySet<string>) =>
	t.filter((w) => !ignore.has(w)).filter((w, i, kept) => i === 0 || kept[i - 1] !== w);

/** Pure: a two-word title's overlap with `b`: both words shared, one of them distinctive, and in order with at most one word between. */
function pairOverlap(
	a: string[],
	b: string[],
	bSize: number,
	shared: string[],
	distinctive: string[],
): string[] | undefined {
	if (shared.length !== 2 || !distinctive.length) return undefined;
	if (bSize === 2) return shared;
	// In order, with at most one word between: "Rename the project to Atlas" is "Rename to Atlas".
	for (let i = 0; i < b.length; i++) if (b[i] === a[0] && (b[i + 1] === a[1] || b[i + 2] === a[1])) return shared;
	return undefined;
}

/** Pure: whether some window of `width` words of `b` holds every word of `need`. */
function sitTogether(b: string[], need: ReadonlySet<string>, width: number): boolean {
	for (let i = 0; i < b.length; i++) {
		const seen = new Set<string>();
		for (let j = i; j < b.length && j - i < width; j++) {
			const w = b[j];
			if (w !== undefined && need.has(w)) seen.add(w);
			if (seen.size === need.size) return true;
		}
	}
	return false;
}

/**
 * Pure: the shared topic words when two titles are about the same thing beyond the subject they both name, else undefined:
 * three distinctive words, and at least half of the shorter title's. What a weak ref must pass. `ignore` are words that
 * say nothing about the topic (the principal's name, a project name).
 */
export function sameTopic(x: string, y: string, ignore: ReadonlySet<string> = new Set()): string[] | undefined {
	const keep = (t: string) => new Set(tokens(t).filter((w) => !GENERIC.has(w) && !ignore.has(w) && !/^\d+$/.test(w)));
	const a = keep(x),
		b = keep(y);
	const shared = [...a].filter((w) => b.has(w));
	return shared.length >= 3 && shared.length / Math.min(a.size, b.size) >= 0.5 ? shared : undefined;
}

const norm = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
/** Pure: does `text` name `title` as a whole phrase? Only a title of 12+ characters and two words counts. */
function names(text: string, title: string | undefined): boolean {
	const t = title ? norm(title) : "";
	if (t.length < 12 || !t.includes(" ")) return false;
	return ` ${norm(text)} `.includes(` ${t} `);
}

/* ---------- the three sources ---------- */

/** What a settled question's answer says on one line: its option or direction, its note and any ruling it saved. */
function queueAnswerText(q: QuestionState): string {
	if (q.status === "answered-on-card") return "answered on its question card";
	const note = q.answer?.note ? ` (${oneLine(q.answer.note, 70)})` : "";
	const ruling = q.answer?.ruling ? `, saved ${q.answer.ruling.id}` : "";
	return `answered "${q.answer?.label ?? "?"}"${note}${ruling}`;
}

function queueRecords(store: Store): SettledRecord[] {
	const out: SettledRecord[] = [];
	for (const q of questionStates(store).values()) {
		// A dismissed item was never answered: it is not a ruling and answers no later question, so a lookup never sees it.
		if (q.status === "open" || q.status === "dismissed") continue;
		const date = String(q.answer?.t ?? q.createdAt ?? "").slice(0, 10);
		const answer = queueAnswerText(q);
		out.push({
			source: "queue",
			date,
			id: q.id,
			answer,
			title: q.title,
			text: `${q.title}\n${q.context ?? ""}\n${q.blocks ?? ""}`,
			thread: q.thread,
		});
	}
	return out;
}

/** The rulings in force at `nowMs`: status in-force and not past its expiry. Proposed, expired, superseded and retired rulings settle nothing. */
function rulingRecords(store: Store, nowMs: number): SettledRecord[] {
	return readRulings(store)
		.filter((r) => r && typeof r === "object" && r.status === "in-force" && !isExpired(r, nowMs))
		.map((r) => ({
			source: "ruling" as const,
			date: String(r.confirmedAt ?? r.date ?? "").slice(0, 10),
			id: r.id,
			answer: `in force: ${oneLine(r.decides)}`,
			title: r.decides,
			text: `${r.words}\n${r.decides}`,
			...(r.item ? { item: r.item } : {}),
		}));
}

function decisionRecords(store: Store): SettledRecord[] {
	return store.decisions
		.list()
		.filter((d) => d && typeof d === "object" && typeof d.t === "string" && typeof d.decision === "string")
		.map((d) => ({
			source: "decision" as const,
			date: d.t.slice(0, 10),
			id: `D@${d.t.slice(0, 16)}`,
			answer: `decided: ${oneLine(d.decision)}${d.ruling ? ` (${oneLine(d.ruling, 40)})` : ""}`,
			title: d.decision,
			text: `${d.decision}\n${d.ruling ?? ""}\n${d.ref ?? ""}`,
			thread: d.thread,
		}));
}

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
			const why = whyMatches(s, body, mine, r, titleOverlap, ignore);
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
	s: Subject,
	body: string,
	mine: Refs,
	r: SettledRecord,
	titleOverlap: boolean,
	ignore: ReadonlySet<string>,
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
