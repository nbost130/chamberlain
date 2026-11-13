/**
 * Standing rulings (the rulings table). A ruling the Steward records is a proposal: it is not in force until the principal
 * confirms it on the rulings page. Only a rule the principal stated in their own words in chat goes in force here.
 *
 *   bun src/core/ruling.ts "<their exact words>" "<what it decides>"                 (a proposal)
 *   bun src/core/ruling.ts --stated-in-chat "<their exact words>" "<what it decides>" (in force: they said it as a rule, in chat)
 *   bun src/core/ruling.ts list
 */
import { principal } from "./config.ts";
import { defaultStore } from "./default-store.ts";
import { startup } from "./migrate.ts";
import { addInForce, propose, readRulings } from "./rulings.ts";

function main() {
	startup();
	const store = defaultStore();
	const argv = process.argv.slice(2);
	if (argv[0] === "list") {
		for (const r of readRulings(store)) console.log(`${r.id}\t${r.status}\t${r.source}\t${r.confirmed ? "confirmed" : "unconfirmed"}\t"${r.words}" -> ${r.decides}`);
		return;
	}
	const chat = argv[0] === "--stated-in-chat";
	const [words, decides] = chat ? argv.slice(1) : argv;
	if (!words || !decides) {
		console.error('usage: ruling.ts [--stated-in-chat] "<their exact words>" "<what it decides>" | list');
		process.exit(2);
	}
	if (chat) {
		const r = addInForce(store, words, decides, "chat", `stated by ${principal()} in chat, recorded by the Steward`);
		console.log(`recorded ${r.id}, in force`);
	} else {
		const r = propose(store, words, decides);
		console.log(`proposed ${r.id}: not in force until ${principal()} confirms it on the rulings page`);
	}
}

if (import.meta.main) main();
