/**
 * The pinned Decisions thread, by hand.
 *
 *   chamberlain decisions repost       (from a checkout: bun src/decisions.ts repost)
 *   chamberlain decisions show <id> [--json]
 *   chamberlain decisions verify <id> [--choice "<label>"] [--thread <id>]
 *
 * `show` and `verify` only read. They tell a thread that was relayed an answer whether Chamberlain's own record says the principal made it
 * (src/core/items/provenance.ts): `verify` exits 0 only when it does and every field the caller gave matches.
 *
 * `repost` posts the live Decisions view into the Decisions thread again, with no new question: the way to bring the view back after a thread
 * was cleaned up or its render was lost. It goes through the same code as every question's post (src/adapters/t3/post.ts: one shell,
 * one configured RPC sender, one guard), so nobody writes the html of a re-post by hand and a re-post is never a shell that lost its height. The post
 * carries the VIEW key and never the page's key, and is refused if it would hold the page's key in any spelling. With the page down or no
 * view key it posts nothing and says why: a re-post must render, so there is no one-line-notice fallback here.
 */

import { postConfigured, viewRepostMessage } from "./adapters/t3/post.ts";
import { inlineView } from "./ask.ts";
import { CONF } from "./core/config/config.ts";
import { startup } from "./core/config/migrate.ts";
import { readProvenance, verify } from "./core/items/provenance.ts";
import { defaultStore } from "./core/store/default-store.ts";

/** What `repost` found out: whether the view was posted, and the one line to say so. */
export type Reposted = { ok: boolean; line: string };

/** Re-posts the pinned view. `view` says where the page is and which key to carry (it is the one `ask` uses); a test gives its own. */
export async function repost(conf = CONF, view = inlineView): Promise<Reposted> {
	const { queueUrl, capability } = await view();
	if (queueUrl === undefined || capability === undefined)
		return {
			ok: false,
			line: "nothing posted: the queue page is not answering or has no view key (start it: chamberlain web)",
		};
	const r = await postConfigured(conf, viewRepostMessage(queueUrl, capability), capability);
	return { ok: r.ok, line: r.ok ? "the Decisions view was posted again" : `the post failed: ${r.detail}` };
}

const USAGE = 'usage: decisions repost | show <id> [--json] | verify <id> [--choice "<label>"] [--thread <id>]';

/** Pure: `show`/`verify` arguments. `flags` holds only the options each command allows; anything else is a usage error (undefined). */
export function readArgs(argv: string[]) {
	const [cmd, id, ...rest] = argv;
	if ((cmd !== "show" && cmd !== "verify") || !id || !/^Q-[a-z0-9]{4,16}$/.test(id)) return undefined;
	const flags: { json?: true; choice?: string; threadId?: string } = {};
	for (let n = 0; n < rest.length; n++) {
		const f = rest[n];
		if (f === "--json" && cmd === "show") flags.json = true;
		else if (f === "--choice" && cmd === "verify" && rest[n + 1] !== undefined) flags.choice = rest[++n];
		else if (f === "--thread" && cmd === "verify" && rest[n + 1] !== undefined) flags.threadId = rest[++n];
		else return undefined;
	}
	return { cmd, id, ...flags };
}

/** `show` and `verify` over a store: the lines to print and the exit code. Reads only. */
export function inspect(store: Parameters<typeof readProvenance>[0], a: NonNullable<ReturnType<typeof readArgs>>) {
	const p = readProvenance(store, a.id);
	if (a.cmd === "show")
		return {
			out: a.json ? JSON.stringify(p, null, 2) : `${p.id}: ${p.answeredBy}${p.why ? ` (${p.why})` : ""}`,
			code: 0,
		};
	const v = verify(p, { choice: a.choice, threadId: a.threadId });
	return { out: v.line, code: v.ok ? 0 : 1 };
}

export async function main(argv: string[] = process.argv.slice(2)) {
	const read = readArgs(argv);
	if (read) {
		startup();
		const r = inspect(defaultStore(), read);
		(r.code === 0 ? console.log : console.error)(r.out);
		process.exitCode = r.code;
		return;
	}
	if (argv[0] !== "repost" || argv.length > 1) {
		console.error(USAGE);
		process.exit(2);
	}
	startup();
	const r = await repost();
	(r.ok ? console.log : console.error)(r.line);
	process.exitCode = r.ok ? 0 : 1;
}

if (import.meta.main)
	main().catch((e) => {
		console.error(String(e instanceof Error ? e.message : e));
		process.exit(1);
	});
