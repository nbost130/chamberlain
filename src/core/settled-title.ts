/** Settled records: when two titles are about the same thing, without any model. */

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
	if (aSet.size === 2) return pairOverlap(a, b, bSet.size, { shared, distinctive });
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
	{ shared, distinctive }: { shared: string[]; distinctive: string[] },
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
export function names(text: string, title: string | undefined): boolean {
	const t = title ? norm(title) : "";
	if (t.length < 12 || !t.includes(" ")) return false;
	return ` ${norm(text)} `.includes(` ${t} `);
}

/* ---------- the three sources ---------- */
