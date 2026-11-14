import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { queueBase, stageEvidence } from "./ask.ts";
import { parseAsk } from "./ask-parse.ts";
import type { Question } from "./core/questions.ts";

const base = {
	kind: "ruling",
	title: "Pick",
	context: "- a",
	options: ["A", "B"],
	thread: "t",
	server: "main",
	proposedRuling: "Do it this way for this launch.",
};
const NOW = new Date().toISOString();
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe("proposedExpires on a question", () => {
	test("a future date or date-time is kept on the item", () => {
		expect(parseAsk({ ...base, proposedExpires: inDays(30) }, "Q-abc12", NOW).proposedExpires).toBe(inDays(30));
		const dt = new Date(Date.now() + 3_600_000).toISOString();
		expect(parseAsk({ ...base, proposedExpires: ` ${dt} ` }, "Q-abc12", NOW).proposedExpires).toBe(dt);
	});
	test("a question without one has none", () => {
		expect(parseAsk(base, "Q-abc12", NOW)).not.toHaveProperty("proposedExpires");
	});
	test("it needs a proposed ruling", () => {
		const { proposedRuling: _p, ...noRuling } = base;
		expect(() => parseAsk({ ...noRuling, proposedExpires: inDays(30) }, "Q-abc12", NOW)).toThrow(
			"proposedExpires needs a proposedRuling",
		);
	});
	test("an unreadable, zoneless, impossible or past value is refused", () => {
		for (const bad of ["next week", `${inDays(3)}T09:00:00`])
			expect(() => parseAsk({ ...base, proposedExpires: bad }, "Q-abc12", NOW)).toThrow(
				"proposedExpires must be an ISO date",
			);
		for (const bad of [
			"2026-02-30",
			"2099-02-30T09:00:00Z",
			"2099-02-29T09:00:00Z",
			"2099-13-01T09:00:00Z",
			"2099-11-13T24:00:00Z",
		])
			expect(() => parseAsk({ ...base, proposedExpires: bad }, "Q-abc12", NOW)).toThrow(
				`proposedExpires "${bad}" is not a real date and time`,
			);
		expect(parseAsk({ ...base, proposedExpires: "2096-02-29T09:00:00Z" }, "Q-abc12", NOW).proposedExpires).toBe(
			"2096-02-29T09:00:00Z",
		);
		expect(() => parseAsk({ ...base, proposedExpires: "2020-01-01" }, "Q-abc12", NOW)).toThrow(
			"proposedExpires is already past",
		);
		expect(() => parseAsk({ ...base, proposedExpires: 5 }, "Q-abc12", NOW)).toThrow("must be a string");
	});
});

const ID = "Q-abc12";
const mk = (o: Record<string, unknown>) => parseAsk({ ...base, ...o }, ID, NOW);
const refuses = (o: Record<string, unknown>, text: string | RegExp) => expect(() => mk(o)).toThrow(text);

describe("parseAsk: the fields", () => {
	test("anything that is not a JSON object is refused", () => {
		for (const raw of [null, undefined, "text", 5, 0])
			expect(() => parseAsk(raw, ID, NOW)).toThrow("ask: expected a JSON object");
	});
	test("a text field is trimmed; a required one that is absent, null or empty, or a field that is not text, is refused", () => {
		const q = mk({ title: "  Pick  ", context: " - a ", thread: " t ", server: " s ", kind: "idea" });
		expect([q.title, q.context, q.thread, q.server, q.kind]).toEqual(["Pick", "- a", "t", "s", "idea"]);
		for (const k of ["kind", "title", "thread", "server"])
			for (const v of [undefined, null, ""]) refuses({ [k]: v }, `ask: "${k}" is required`);
		refuses({ title: 5 }, 'ask: "title" must be a string');
		refuses({ thread: {} }, 'ask: "thread" must be a string');
		expect(mk({ context: undefined }).context).toBe("");
		expect(mk({ context: "" }).context).toBe("");
		refuses({ kind: "nope" }, /ask: kind must be one of/);
	});
	test("the optional fields are kept when given and left off when empty", () => {
		const bare = mk({});
		for (const k of ["threadId", "blocks", "tag", "secret", "urgent", "notSettled", "recommended", "evidence"])
			expect(bare).not.toHaveProperty(k);
		const full = mk({ threadId: " th ", blocks: " b ", tag: " Approval ", notSettled: " why ", recommended: 1 });
		expect([full.threadId, full.blocks, full.tag, full.notSettled, full.recommended]).toEqual([
			"th",
			"b",
			"Approval",
			"why",
			1,
		]);
		expect(full.createdAt).toBe(NOW);
		expect(full.id).toBe(ID);
		for (const k of ["threadId", "blocks", "tag", "notSettled"]) expect(mk({ [k]: "" })).not.toHaveProperty(k);
		expect(parseAsk(base, ID).createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
	});
});

describe("parseAsk: the options", () => {
	test("an option is a label or an object, and (Recommended) is stripped from the end of a label only", () => {
		const q = mk({
			options: [
				"A (Recommended)",
				{ label: "  B  (recommended) ", detail: " why " },
				{ label: "(Recommended) C" },
				{ label: "D", detail: 5 },
			],
		});
		expect(q.options).toEqual([
			{ label: "A" },
			{ label: "B", detail: "why" },
			{ label: "(Recommended) C" },
			{ label: "D" },
		]);
		expect(mk({ options: [{ label: "A", detail: "  " }, "B"] }).options[0]).toEqual({ label: "A" });
	});
	test("an option needs a label", () => {
		for (const bad of [{}, null, "", "  ", { label: 5 }, { label: " " }, 5, ["a"]])
			refuses({ options: [bad, "B"] }, "ask: option 1 needs a label");
		refuses({ options: ["A", {}] }, "ask: option 2 needs a label");
	});
	test("a route is thread or steward, and a thread route needs relay text and the item's threadId; a steward option keeps none", () => {
		const q = mk({
			threadId: "th",
			options: [
				{ label: "A", route: "thread", relay: " do it " },
				{ label: "B", route: "steward", relay: "ignored" },
				{ label: "C", route: null, relay: null },
				{ label: "D", relay: "ignored" },
			],
		});
		expect(q.options).toEqual([
			{ label: "A", route: "thread", relay: "do it" },
			{ label: "B" },
			{ label: "C" },
			{ label: "D" },
		]);
		refuses(
			{ options: [{ label: "A", route: "elsewhere" }, "B"] },
			'ask: option 1 route must be "thread" or "steward"',
		);
		refuses({ options: [{ label: "A", route: 5 }, "B"] }, 'ask: option 1 route must be "thread" or "steward"');
		refuses({ options: [{ label: "A", relay: 5 }, "B"] }, "ask: option 1 relay must be a string");
		refuses(
			{ options: ["A", { label: "B", route: "thread" }], threadId: "th" },
			"ask: option 2 routes to the thread, so it needs relay text",
		);
		refuses({ options: ["A", { label: "B", route: "thread", relay: "  " }], threadId: "th" }, "needs relay text");
		refuses(
			{ options: ["A", { label: "B", route: "thread", relay: "go" }] },
			"ask: an option routed to the thread needs the item's threadId",
		);
		refuses(
			{ options: ["A", { label: "B", route: "thread", relay: "go" }], threadId: "  " },
			"needs the item's threadId",
		);
	});
	test("two to nine options, or none for a secret", () => {
		refuses({ options: ["A"] }, "ask: give at least two options");
		refuses({ options: undefined }, "ask: give at least two options");
		refuses({ options: "A,B" }, "ask: give at least two options");
		expect(mk({ options: Array.from({ length: 9 }, (_, i) => `o${i}`) }).options).toHaveLength(9);
		refuses({ options: Array.from({ length: 10 }, (_, i) => `o${i}`) }, "ask: at most nine options (keys 1-9)");
		const secret = mk({ secret: true, options: [] });
		expect([secret.options, secret.secret]).toEqual([[], true]);
		refuses({ secret: true, options: Array.from({ length: 10 }, (_, i) => `o${i}`) }, "at most nine options");
		refuses(
			{ secret: true, threadId: "th", options: [{ label: "A", route: "thread", relay: "go" }] },
			"ask: a secret is never answered on the page",
		);
		expect(mk({ secret: "yes", options: ["A", "B"] })).not.toHaveProperty("secret");
	});
	test("recommended is an option index from 0, or absent", () => {
		expect(mk({ recommended: 0 }).recommended).toBe(0);
		expect(mk({ recommended: 1 }).recommended).toBe(1);
		expect(mk({ recommended: null })).not.toHaveProperty("recommended");
		for (const bad of [-1, 2, 1.5, "1", true, Number.NaN])
			refuses({ recommended: bad }, "ask: recommended must be an option index from 0");
	});
});

describe("parseAsk: the evidence", () => {
	test("each entry is an image, video or link; a link needs an http(s) url and a file needs a path", () => {
		const q = mk({
			evidence: [
				{ type: "image", path: "/a.png", caption: "c" },
				{ type: "video", path: "/b.mp4", caption: 5 },
				{ type: "link", url: "https://x/y", caption: "" },
				{ type: "link", url: "http://x", path: "/p" },
				{ type: "image", path: "/c.png", url: "u" },
			],
		});
		expect(q.evidence).toEqual([
			{ type: "image", path: "/a.png", caption: "c" },
			{ type: "video", path: "/b.mp4", caption: "5" },
			{ type: "link", url: "https://x/y" },
			{ type: "link", path: "/p", url: "http://x" },
			{ type: "image", path: "/c.png", url: "u" },
		]);
		expect(mk({ evidence: [] })).not.toHaveProperty("evidence");
		expect(mk({ evidence: "x" })).not.toHaveProperty("evidence");
		for (const bad of [null, {}, { type: "audio" }, "image"])
			refuses({ evidence: [bad] }, "ask: evidence 1 needs type image, video or link");
		for (const bad of [{ type: "link" }, { type: "link", url: "ftp://x" }, { type: "link", url: 5 }])
			refuses({ evidence: [{ type: "image", path: "/a.png" }, bad] }, "ask: evidence 2 needs an http(s) url");
		for (const bad of [{ type: "image" }, { type: "video", path: "" }, { type: "image", path: 5 }])
			refuses({ evidence: [bad] }, "ask: evidence 1 needs a path");
	});
});

describe("parseAsk: urgency", () => {
	test("urgent must be true or false, and only false is kept", () => {
		refuses({ urgent: "no" }, 'ask: "urgent" must be true or false');
		refuses({ urgent: 0 }, 'ask: "urgent" must be true or false');
		expect(mk({ urgent: false }).urgent).toBe(false);
		expect(mk({ urgent: true })).not.toHaveProperty("urgent");
		refuses({ urgent: null }, 'ask: "urgent" must be true or false');
	});
	test("urgent: false on an approval or a secret is dropped, with a line saying which, and warns once", () => {
		const heard: string[] = [];
		const keep = (o: Record<string, unknown>) => parseAsk({ ...base, ...o }, ID, NOW, (l) => heard.push(l));
		for (const o of [{ tag: "Approval" }, { tag: "approval" }, { tag: "Secret" }, { secret: true, options: [] }])
			expect(keep({ ...o, urgent: false })).not.toHaveProperty("urgent");
		expect(heard).toEqual([
			'ask: "urgent": false ignored: an approval is always urgent, so it is filed and posted as urgent',
			'ask: "urgent": false ignored: an approval is always urgent, so it is filed and posted as urgent',
			'ask: "urgent": false ignored: a secret is always urgent, so it is filed and posted as urgent',
			'ask: "urgent": false ignored: a secret is always urgent, so it is filed and posted as urgent',
		]);
		heard.length = 0;
		expect(keep({ tag: "Other", urgent: false }).urgent).toBe(false);
		expect(keep({ tag: "Approval", urgent: true })).not.toHaveProperty("urgent");
		expect(keep({ tag: "Approval" })).not.toHaveProperty("urgent");
		expect(heard).toEqual([]);
	});
	test("without a warn function the note goes to stderr", () => {
		const seen: unknown[] = [];
		const was = console.error;
		console.error = (...a: unknown[]) => void seen.push(...a);
		try {
			parseAsk({ ...base, tag: "Approval", urgent: false }, ID, NOW);
		} finally {
			console.error = was;
		}
		expect(seen).toEqual([
			'ask: "urgent": false ignored: an approval is always urgent, so it is filed and posted as urgent',
		]);
	});
});

describe("stageEvidence", () => {
	const dir = () => mkdtempSync(`${tmpdir()}/chamberlain-stage-`);
	const itemOf = (evidence: Question["evidence"]): Question => ({ ...mk({}), evidence });
	test("an item with no evidence comes back as it is", () => {
		const q = mk({});
		expect(stageEvidence(q, dir())).toBe(q);
		const empty = itemOf([]);
		expect(stageEvidence(empty, dir())).toBe(empty);
	});
	test("a link stays; a file is copied under a safe, unique name and its path becomes that name", () => {
		const d = dir();
		mkdirSync(`${d}/a`);
		mkdirSync(`${d}/b`);
		writeFileSync(`${d}/a/Shot (1).PNG`, "one");
		writeFileSync(`${d}/b/Shot (1).PNG`, "two");
		writeFileSync(`${d}/a/.hidden.mp4`, "vid");
		const out = stageEvidence(
			itemOf([
				{ type: "image", path: `${d}/a/Shot (1).PNG`, caption: "x" },
				{ type: "link", url: "https://x" },
				{ type: "image", path: `${d}/b/Shot (1).PNG` },
				{ type: "video", path: `${d}/a/.hidden.mp4` },
			]),
			`${d}/state`,
		);
		expect(out.evidence).toEqual([
			{ type: "image", path: "Shot__1_.PNG", caption: "x" },
			{ type: "link", url: "https://x" },
			{ type: "image", path: "3-Shot__1_.PNG" },
			{ type: "video", path: "hidden.mp4" },
		]);
		expect(Bun.file(`${d}/state/evidence/${ID}/Shot__1_.PNG`).size).toBe(3);
		expect(Bun.file(`${d}/state/evidence/${ID}/3-Shot__1_.PNG`).size).toBe(3);
	});
	test("a leading ~/ is the home directory", () => {
		const home = process.env.HOME ?? "";
		const name = `chamberlain-home-${process.pid}.png`;
		writeFileSync(`${home}/${name}`, "png");
		const out = stageEvidence(itemOf([{ type: "image", path: `~/${name}` }]), dir());
		expect(out.evidence?.[0]?.path).toBe(name);
	});
	test("a missing file, a directory, a symlink and a wrong extension are refused, naming the entry", () => {
		const d = dir();
		mkdirSync(`${d}/folder.png`);
		writeFileSync(`${d}/real.png`, "x");
		writeFileSync(`${d}/notes.txt`, "x");
		symlinkSync(`${d}/real.png`, `${d}/link.png`);
		const stage = (e: NonNullable<Question["evidence"]>[number]) => () =>
			stageEvidence(itemOf([{ type: "link", url: "https://x" }, e]), d);
		for (const p of [`${d}/nope.png`, `${d}/folder.png`, `${d}/link.png`])
			expect(stage({ type: "image", path: p })).toThrow(`ask: evidence 2 is not a regular file: ${p}`);
		expect(stage({ type: "image", path: `${d}/notes.txt` })).toThrow("ask: evidence 2 must be png, jpg, gif or webp");
		expect(stage({ type: "video", path: `${d}/real.png` })).toThrow("ask: evidence 2 must be mp4, webm or mov");
	});
});

describe("queueBase", () => {
	const conf = (web: unknown) => {
		const c = mkdtempSync(`${tmpdir()}/chamberlain-qb-`);
		chmodSync(c, 0o700);
		if (web !== undefined) writeFileSync(`${c}/web.json`, JSON.stringify(web), { mode: 0o600 });
		return c;
	};
	test("an https publicBase wins; otherwise host and port, bracketed for an IPv6 host; otherwise none", () => {
		expect(queueBase(conf({ host: "127.0.0.1", port: 3790, publicBase: "https://box.example" }))).toBe(
			"https://box.example",
		);
		expect(queueBase(conf({ host: "127.0.0.1", port: 3790, publicBase: "http://box.example" }))).toBe(
			"http://127.0.0.1:3790",
		);
		expect(queueBase(conf({ host: "127.0.0.1", port: 3790, publicBase: "https://box.example/x" }))).toBe(
			"http://127.0.0.1:3790",
		);
		expect(queueBase(conf({ host: "::1", port: 3790 }))).toBe("http://[::1]:3790");
		expect(queueBase(conf({ host: "127.0.0.1" }))).toBeUndefined();
		expect(queueBase(conf({ port: 3790 }))).toBeUndefined();
		expect(queueBase(conf(undefined))).toBeUndefined();
	});
	test("a web.json that cannot be read means no page", () => {
		const c = conf({ host: "127.0.0.1", port: 3790 });
		chmodSync(`${c}/web.json`, 0o644);
		expect(queueBase(c)).toBeUndefined();
	});
});

describe("main: the inline view's key", () => {
	const urgent = { ...base, kind: "product", tag: "Approval", proposedRuling: undefined, notSettled: "test" };
	function scratch(web: { host: string; port: number } | undefined, token?: { text: string; mode: number }) {
		const d = mkdtempSync(`${tmpdir()}/chamberlain-askmain-`);
		mkdirSync(`${d}/state`);
		mkdirSync(`${d}/conf/secrets`, { recursive: true, mode: 0o700 });
		chmodSync(`${d}/conf`, 0o700);
		if (web) writeFileSync(`${d}/conf/web.json`, JSON.stringify(web), { mode: 0o600 });
		if (token) writeFileSync(`${d}/conf/secrets/view-key`, token.text, { mode: token.mode });
		if (token) chmodSync(`${d}/conf/secrets/view-key`, token.mode);
		return d;
	}
	async function run(d: string, ...args: string[]) {
		const {
			XDG_STATE_HOME: _s,
			XDG_CACHE_HOME: _c,
			XDG_CONFIG_HOME: _f,
			CHAMBERLAIN_STATE: _a,
			CHAMBERLAIN_CONF: _g,
			...rest
		} = process.env;
		const p = Bun.spawn([process.execPath, new URL("./ask.ts", import.meta.url).pathname, ...args], {
			env: { ...rest, HOME: d, CHAMBERLAIN_STATE: `${d}/state`, CHAMBERLAIN_CONF: `${d}/conf` },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		return { out, err, code };
	}
	const ask = (d: string) => run(d, JSON.stringify(urgent));
	const withPage = async (fn: (port: number) => Promise<void>) => {
		const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("//js") });
		try {
			await fn(server.port ?? 0);
		} finally {
			server.stop(true);
		}
	};
	test("no argument is a usage error", async () => {
		const r = await run(scratch(undefined));
		expect([r.code, r.err]).toEqual([2, "usage: ask.ts '<json>' | ask.ts - < item.json\n"]);
	});
	test("the JSON may come on stdin", async () => {
		const d = scratch(undefined);
		const p = Bun.spawn([process.execPath, new URL("./ask.ts", import.meta.url).pathname, "-"], {
			env: { ...process.env, HOME: d, CHAMBERLAIN_STATE: `${d}/state`, CHAMBERLAIN_CONF: `${d}/conf` },
			stdin: new Blob([JSON.stringify({ ...urgent, tag: undefined, urgent: false })]),
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await new Response(p.stdout).text()).toMatch(
			/^Q-\w+ \(on the queue page, not urgent: no notification sent\)\n$/,
		);
		expect(await p.exited).toBe(0);
	});
	test("a page that answers but has no key yet says so, and the post still goes on", async () => {
		await withPage(async (port) => {
			const r = await ask(scratch({ host: "127.0.0.1", port }));
			expect(r.err).toContain(
				"the page has no view key yet: start the page (chamberlain web); posting a notice instead of the view",
			);
			expect(r.err).toContain("ask: the Decisions thread is not set (threads.decisions in config.json)");
			expect(r.code).toBe(1);
		});
	});
	test("a key that cannot be read says why (and, having none, that there is none), and the post still goes on", async () => {
		await withPage(async (port) => {
			const r = await ask(scratch({ host: "127.0.0.1", port }, { text: "k".repeat(43), mode: 0o644 }));
			expect(r.err).toContain(
				"the view key could not be read (view-key must be a private regular file with mode exactly 0600",
			);
			expect(r.err).toContain("posting a notice instead of the view");
			// An unreadable key also leaves no key, so the second notice follows the first.
			expect(r.err).toContain("the page has no view key yet");
			expect(r.code).toBe(1);
		});
	});
	test("a readable key, or a page that does not answer, prints neither notice", async () => {
		await withPage(async (port) => {
			const r = await ask(scratch({ host: "127.0.0.1", port }, { text: "k".repeat(43), mode: 0o600 }));
			expect(r.err).not.toContain("key");
			expect(r.code).toBe(1);
		});
		const down = await ask(scratch({ host: "127.0.0.1", port: 9 }));
		expect(down.err).not.toContain("key");
		expect(down.code).toBe(1);
		const unset = await ask(scratch(undefined));
		expect(unset.err).not.toContain("key");
	});
});
