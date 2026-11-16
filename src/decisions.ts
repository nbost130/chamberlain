/**
 * The pinned Decisions thread, by hand.
 *
 *   chamberlain decisions repost       (from a checkout: bun src/decisions.ts repost)
 *
 * `repost` posts the live Decisions view into the Decisions thread again, with no new question: the way to bring the view back after a thread
 * was cleaned up or its render was lost. It goes through the same code as every question's post (src/adapters/t3/post.ts: one shell, one
 * `pingViaCli`, one guard), so nobody writes the html of a re-post by hand and a re-post is never a shell that lost its height. The post
 * carries the VIEW key and never the page's key, and is refused if it would hold the page's key in any spelling. With the page down or no
 * view key it posts nothing and says why: a re-post must render, so there is no one-line-notice fallback here.
 */
import { repostView } from "./adapters/t3/post.ts";
import { inlineView } from "./ask.ts";
import { CONF } from "./core/config/config.ts";
import { startup } from "./core/config/migrate.ts";

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
	const r = repostView(conf, queueUrl, capability);
	return { ok: r.ok, line: r.ok ? "the Decisions view was posted again" : `the post failed: ${r.detail}` };
}

export async function main(argv: string[] = process.argv.slice(2)) {
	if (argv[0] !== "repost" || argv.length > 1) {
		console.error("usage: decisions repost");
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
