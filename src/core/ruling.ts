/**
 * Standing rulings (the rulings table). A ruling the Steward records is a proposal: it is not in force until the principal
 * confirms it on the rulings page. Only a rule the principal stated in their own words in chat goes in force here.
 *
 *   bun src/core/ruling.ts "<their exact words>" "<what it decides>"                 (a proposal)
 *   bun src/core/ruling.ts --stated-in-chat "<their exact words>" "<what it decides>" (in force: they said it as a rule, in chat)
 * Either form takes, before the words:
 *   --expires <ISO date or date-time>   a time-bound ruling: left out of every wake after it, marked expired on the page.
 *                                       A date runs through the end of that day (UTC); a date-time needs a zone (Z or +02:00).
 *   --until "<event>"                   a time bound only a person can judge ("until the V2 launch"); shown, never enforced
 *   --supersedes R32,R16                the rulings this one replaces: they leave force (at once, or when the principal confirms a proposal)
 *   --                                  everything after it is the words, even text that starts with "--"
 * Recording the same words and decision as a live ruling adds nothing: it prints the id already held.
 *
 *   bun src/core/ruling.ts list
 */
import { principal } from "./config.ts";
import { defaultStore } from "./default-store.ts";
import { startup } from "./migrate.ts";
import { addInForce, propose, type RulingOpts, readRulings } from "./rulings.ts";
import type { Store } from "./store.ts";

const USAGE =
	'usage: ruling.ts [--stated-in-chat] [--expires <ISO>] [--until "<event>"] [--supersedes R32,R16] [--] "<their exact words>" "<what it decides>" | list';

/** The flags that carry a value: what each does to the options. */
const VALUE_FLAGS = new Map<string, (opts: RulingOpts, value: string) => void>([
	[
		"--expires",
		(opts, v) => {
			opts.expires = v;
		},
	],
	[
		"--until",
		(opts, v) => {
			opts.until = v;
		},
	],
	[
		"--supersedes",
		(opts, v) => {
			opts.supersedes = v.split(",");
		},
	],
]);

/** The value that follows a flag, taken off the front of what is left; throws when there is none. */
function takeValue(rest: string[], flag: string): string {
	const v = rest.shift();
	if (v === undefined) throw Error(`${flag} needs a value`);
	return v;
}

/** Pure: the flags and the two texts of a recording call. Throws on a flag it doesn't know or one missing its value. */
export function parseArgs(argv: string[]): { chat: boolean; opts: RulingOpts; words?: string; decides?: string } {
	let chat = false;
	const opts: RulingOpts = {};
	const rest: string[] = [];
	const todo = [...argv];
	let literal = false; // after a bare "--", everything is words, even text that starts with "--"
	for (let a = todo.shift(); a !== undefined; a = todo.shift()) {
		const setValue = VALUE_FLAGS.get(a);
		if (literal) rest.push(a);
		else if (a === "--") literal = true;
		else if (a === "--stated-in-chat") chat = true;
		else if (setValue) setValue(opts, takeValue(todo, a));
		// A lone word like --expire is a mistyped flag; words that start with "--" have spaces, or come after "--".
		else if (/^--[\w-]+$/.test(a))
			throw Error(`unknown flag ${a} (put their words after "--" if they really start with it)`);
		else rest.push(a);
	}
	return { chat, opts, words: rest[0], decides: rest[1] };
}

/** A recording call whose two texts are present. */
type Recording = { chat: boolean; opts: RulingOpts; words: string; decides: string };

/** The call's flags and texts; a bad flag or a missing text prints the reason and the usage and exits 2. */
function parseOrExit(argv: string[]): Recording {
	let a: ReturnType<typeof parseArgs>;
	try {
		a = parseArgs(argv);
	} catch (e) {
		console.error(`${(e as Error).message}\n${USAGE}`);
		process.exit(2);
	}
	const { words, decides } = a;
	if (!words || !decides) {
		console.error(USAGE);
		process.exit(2);
	}
	return { chat: a.chat, opts: a.opts, words, decides };
}

function printRulings(store: Store) {
	for (const r of readRulings(store))
		console.log(
			`${r.id}\t${r.status}\t${r.source}\t${r.confirmed ? "confirmed" : "unconfirmed"}${r.expires ? `\texpires ${r.expires}` : ""}\t"${r.words}" -> ${r.decides}`,
		);
}

/** Records the words as a ruling in force, and says what happened. */
function recordInChat(store: Store, a: Recording): string {
	const sup = a.opts.supersedes?.length ? a.opts.supersedes.join(", ") : undefined;
	const r = addInForce(
		store,
		a.words,
		a.decides,
		"chat",
		`stated by ${principal()} in chat, recorded by the Steward`,
		undefined,
		a.opts,
	);
	return r.duplicate
		? `already recorded as ${r.id} (${r.status}); ${r.supersedesAdded?.length ? `it now also supersedes ${r.supersedesAdded.join(", ")}, retired as superseded now` : "nothing new added"}`
		: `recorded ${r.id}, in force${sup ? `; ${sup} retired as superseded` : ""}`;
}

/** Records the words as a proposal, and says what happened. */
function recordProposal(store: Store, a: Recording): string {
	const sup = a.opts.supersedes?.length ? a.opts.supersedes.join(", ") : undefined;
	const r = propose(store, a.words, a.decides, undefined, a.opts);
	const added = r.supersedesAdded?.join(", ");
	if (r.alreadyInForce)
		return `already recorded as ${r.id} (in force); nothing new added${r.supersedesNotAdded?.length ? `. It does not supersede ${r.supersedesNotAdded.join(", ")}: a proposal cannot change a ruling in force; ${principal()} retires or replaces it on the rulings page` : ""}`;
	if (r.duplicate)
		return `already recorded as ${r.id} (${r.status}); ${added ? `it now also supersedes ${added}, ${r.status === "in-force" ? "retired as superseded now" : `retired when ${principal()} confirms it`}` : "nothing new added"}`;
	return `proposed ${r.id}: not in force until ${principal()} confirms it on the rulings page${sup ? `; it retires ${sup} when they do` : ""}`;
}

export function main(argv: string[] = process.argv.slice(2)) {
	startup();
	const store = defaultStore();
	if (argv[0] === "list") return printRulings(store);
	const a = parseOrExit(argv);
	try {
		console.log(a.chat ? recordInChat(store, a) : recordProposal(store, a));
	} catch (e) {
		console.error((e as Error).message);
		process.exit(1);
	}
}

if (import.meta.main) main();
