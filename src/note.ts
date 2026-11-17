/**
 * A thread's report to the Steward, held for the Steward's next idle moment (src/core/delivery/note.ts):
 *
 *   chamberlain note --from "<thread title>" [--thread <thread id>] [--server <name>] '<text>'
 *   chamberlain note --from "<thread title>" ... -        (the text on stdin)
 *
 * Use it in place of a t3_thread_send to the Steward for a report that needs no reply now: a status, a result, a batch of PR heads. A busy
 * Steward gets it in its next digest instead of as one more queued turn. It runs on the Steward's machine, against the daemon's state
 * directory; from another machine run it there over ssh.
 * Prints the delivery id. Exits 0 held (or the same note was already held or sent), 2 usage or a malformed note, 3 no live daemon here.
 */
import { parseArgs } from "node:util";
import { startup } from "./core/config/migrate.ts";
import { queueNote } from "./core/delivery/note.ts";
import { defaultStore } from "./core/store/default-store.ts";

const USAGE = "usage: note --from <thread title> [--thread <thread id>] [--server <name>] '<text>' | -";

async function readArgs(argv: string[]) {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { from: { type: "string" }, thread: { type: "string" }, server: { type: "string" } },
		allowPositionals: true,
	});
	const [arg, ...rest] = positionals;
	if (!values.from || arg === undefined || rest.length) return undefined;
	const text = arg === "-" ? await Bun.stdin.text() : arg;
	return {
		from: values.from,
		text,
		...(values.thread ? { thread: values.thread } : {}),
		...(values.server ? { server: values.server } : {}),
	};
}

export async function main(argv: string[] = process.argv.slice(2)) {
	let note: Awaited<ReturnType<typeof readArgs>>;
	try {
		note = await readArgs(argv);
	} catch (e) {
		console.error(`note: ${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
		process.exitCode = 2;
		return;
	}
	if (!note) {
		console.error(USAGE);
		process.exitCode = 2;
		return;
	}
	startup();
	const store = defaultStore();
	try {
		const r = queueNote(store, note);
		if (!r.ok) {
			console.error(r.error);
			process.exitCode = r.code;
			return;
		}
		console.log(
			r.status === "held"
				? `${r.deliveryId} held for the Steward: it goes when the Steward is idle, or in its next digest`
				: `${r.deliveryId} is already held or sent: this same note went once and goes no more`,
		);
	} finally {
		store.close();
	}
}

if (import.meta.main) void main();
