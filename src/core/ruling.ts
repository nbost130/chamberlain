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
import { addInForce, propose, readRulings, type RulingOpts } from "./rulings.ts";

const USAGE = 'usage: ruling.ts [--stated-in-chat] [--expires <ISO>] [--until "<event>"] [--supersedes R32,R16] [--] "<their exact words>" "<what it decides>" | list';

/** Pure: the flags and the two texts of a recording call. Throws on a flag it doesn't know or one missing its value. */
export function parseArgs(argv: string[]): { chat: boolean; opts: RulingOpts; words?: string; decides?: string } {
	let chat = false;
	const opts: RulingOpts = {};
	const rest: string[] = [];
	let literal = false; // after a bare "--", everything is words, even text that starts with "--"
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		const value = () => { const v = argv[++i]; if (v === undefined) throw Error(`${a} needs a value`); return v; };
		if (literal) rest.push(a);
		else if (a === "--") literal = true;
		else if (a === "--stated-in-chat") chat = true;
		else if (a === "--expires") opts.expires = value();
		else if (a === "--until") opts.until = value();
		else if (a === "--supersedes") opts.supersedes = value().split(",");
		// A lone word like --expire is a mistyped flag; words that start with "--" have spaces, or come after "--".
		else if (/^--[\w-]+$/.test(a)) throw Error(`unknown flag ${a} (put their words after "--" if they really start with it)`);
		else rest.push(a);
	}
	return { chat, opts, words: rest[0], decides: rest[1] };
}

function main() {
	startup();
	const store = defaultStore();
	const argv = process.argv.slice(2);
	if (argv[0] === "list") {
		for (const r of readRulings(store)) console.log(`${r.id}\t${r.status}\t${r.source}\t${r.confirmed ? "confirmed" : "unconfirmed"}${r.expires ? `\texpires ${r.expires}` : ""}\t"${r.words}" -> ${r.decides}`);
		return;
	}
	let a: ReturnType<typeof parseArgs>;
	try { a = parseArgs(argv); } catch (e) { console.error(`${(e as Error).message}\n${USAGE}`); process.exit(2); }
	if (!a.words || !a.decides) { console.error(USAGE); process.exit(2); }
	try {
		const sup = a.opts.supersedes?.length ? a.opts.supersedes.join(", ") : undefined;
		if (a.chat) {
			const r = addInForce(store, a.words, a.decides, "chat", `stated by ${principal()} in chat, recorded by the Steward`, undefined, a.opts);
			console.log(r.duplicate ? `already recorded as ${r.id} (${r.status}); nothing new added${sup ? `; ${sup} retired as superseded` : ""}` : `recorded ${r.id}, in force${sup ? `; ${sup} retired as superseded` : ""}`);
		} else {
			const r = propose(store, a.words, a.decides, undefined, a.opts);
			console.log(r.duplicate ? `already recorded as ${r.id} (${r.status}); nothing new added` : `proposed ${r.id}: not in force until ${principal()} confirms it on the rulings page${sup ? `; it retires ${sup} when they do` : ""}`);
		}
	} catch (e) { console.error((e as Error).message); process.exit(1); }
}

if (import.meta.main) main();
