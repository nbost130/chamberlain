/**
 * What the parity test (src/web/inline-parity.test.ts) shares: the full queue page (static/app.js) run against stubbed browser globals on one queue
 * reply, its visible text and addresses, and question and card fixtures in which every field the page could show carries its own marker.
 */
import { readFileSync } from "node:fs";

/** The full page rendered at `pathname` over one /api/queue reply: its HTML. */
export async function webPage(queue: Record<string, unknown>, pathname: string): Promise<string> {
	const app: any = { innerHTML: "", className: "", addEventListener() {} };
	const document = {
		getElementById: (id: string) => (id === "app" ? app : { textContent: "", className: "", hidden: false }),
		addEventListener() {},
		querySelector: () => null,
		activeElement: null,
	};
	const fetch = async () => ({ ok: true, status: 200, json: async () => ({ rulings: [], ...queue }) });
	const noop = () => {};
	new Function(
		"document",
		"window",
		"location",
		"history",
		"matchMedia",
		"fetch",
		"setTimeout",
		"clearTimeout",
		"setInterval",
		readFileSync(new URL("../web/static/app.js", import.meta.url), "utf8"),
	)(
		document,
		{ addEventListener: noop },
		{ pathname },
		{ replaceState: noop, pushState: noop },
		() => ({ matches: false }),
		fetch,
		() => 0,
		noop,
		() => 0,
	);
	await new Promise((r) => setTimeout(r, 10));
	return app.innerHTML;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
/** The text a person reads on the page: the HTML without its tags, entities decoded, lower case (the two views differ in case, never in words). */
export const visibleText = (html: string) =>
	html
		.replace(/<[^>]*>/g, " ")
		.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m)
		.replace(/\s+/g, " ")
		.toLowerCase();
/** Every src and href on the page, entities decoded. */
export const addresses = (html: string) =>
	[...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) =>
		m[1]!.replace(/&(amp|lt|gt|quot|#39);/g, (x) => ENTITIES[x]!),
	);

const MIN = 60_000;
/** A question in which every field carries a marker, so whatever the page shows of it can be looked for in the inline card. */
export const fullQuestion = (over: Record<string, unknown> = {}) => ({
	id: "Q-par1",
	kind: "product",
	title: "Title-mark",
	context: "Ctx-intro-mark\n- Ctx-bullet-mark\nCtx-tail-mark",
	options: [
		{ label: "Opt0-mark", detail: "Det0-mark", route: "thread", relay: "Relay-mark" },
		{ label: "Opt1-mark", detail: "Det1-mark" },
	],
	recommended: 0,
	proposedRuling: "Ruling-mark",
	proposedExpires: "2027-01-01",
	evidence: [
		{ type: "image", path: "erd.png", caption: "Cap-img-mark" },
		{ type: "video", path: "demo.mp4", caption: "Cap-vid-mark" },
		{ type: "link", url: "https://example.com/link-mark", caption: "Cap-link-mark" },
		{ type: "link", url: "https://example.com/bare-link-mark" },
	],
	thread: "Thread-mark",
	server: "Server-mark",
	threadId: "Threadid-mark",
	blocks: "Blocks-mark",
	tag: "Tag-mark",
	urgent: false,
	notSettled: "Notsettled-mark",
	createdAt: new Date(Date.now() - 5 * MIN).toISOString(),
	status: "open",
	delivered: true,
	notNowAt: new Date(Date.now() - MIN).toISOString(),
	batchable: false,
	open: "/open/Server-mark/Threadid-mark",
	...over,
});

/** Cards waiting in other threads: a question card, an approval with its command, and one the page cannot answer. */
export const fullCards = () => [
	{
		id: "C-par000000001",
		type: "question",
		server: "Cserver-mark",
		threadId: "ct1",
		threadTitle: "Cthread-mark",
		requestId: "Req-mark",
		header: "Cheader-mark",
		question: "Cquestion-mark",
		options: [{ label: "Copt0-mark", detail: "Cdet0-mark" }, { label: "Copt1-mark" }],
		recommended: 0,
		answerable: true,
		sig: "Sig-mark",
		link: "t3-thread://v2/env/ct1",
		open: "/open/Cserver-mark/ct1",
	},
	{
		id: "C-par000000002",
		type: "approval",
		server: "Cserver2-mark",
		threadId: "ct2",
		threadTitle: "Cthread2-mark",
		requestId: "Req2-mark",
		header: "Cheader2-mark",
		question: "Cquestion2-mark",
		command: "Cmd-mark --all",
		options: [{ label: "Approve-mark" }, { label: "Decline-mark" }],
		recommended: 0,
		answerable: true,
		sig: "Sig2-mark",
	},
	{
		id: "C-par000000003",
		type: "secret",
		server: "Cserver3-mark",
		threadId: "ct3",
		threadTitle: "Cthread3-mark",
		requestId: "Req3-mark",
		header: "Cheader3-mark",
		question: "Cquestion3-mark",
		options: [],
		answerable: false,
		why: "Why-mark",
		sig: "Sig3-mark",
	},
];

/** Every string in a value, however deep, one per line and without a list's "- " (both views show context as lines): the markers a fixture carries. */
export const strings = (v: unknown): string[] =>
	typeof v === "string"
		? v.split("\n").map((l) => l.replace(/^(?:- |• )/, ""))
		: v && typeof v === "object"
			? Object.values(v).flatMap(strings)
			: [];
