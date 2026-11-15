/** Runs the Decisions view (static/inline.js) against a tiny in-memory DOM, to check what a refresh shows. */

import { expect, test } from "bun:test";
import { run, settle } from "../testing/inline-dom.ts";
import { card, ctxOf, INLINE_PATHS, item } from "../testing/web-inline-view-fixtures.ts";

test("health card shows context meter, preserves expanded evidence, and labels each elevated signal", async () => {
	const h = {
		at: new Date().toISOString(),
		verdict: "HAND OFF",
		tokens: 275000,
		replies: 20,
		breaks: 3,
		selfReads: 3,
		threadRereads: 0,
		elevated: ["format", "rereading"],
		unknown: [],
		report: "Evidence",
	};
	const dq = run(() => ({
		items: [],
		health: h,
		healthLimits: { context: 200000, compactContext: 350000, selfReads: 3, threadRereads: 4 },
	}));
	await settle();
	expect(dq.textContent).toContain("HAND OFF");
	const health = dq.querySelector(".dq-health")!;
	expect(health.tag).toBe("details");
	expect(health.open).toBe(false);
	const summary = health.querySelector("summary")!;
	expect(summary.textContent).toContain("275k / 350k");
	expect(summary.textContent).toContain("Slips 3/20");
	expect(summary.textContent).toContain("Reads 3 self · 0 repeat");
	expect(summary.textContent).toContain("Checked just now");
	expect(dq.all((e) => e.attrs.role === "meter")[0]!.attrs["aria-valuenow"]).toBe("275000");
	expect(dq.all((e) => e.className === "dq-health-fill")[0]!.style.width).toBe(`${(275 / 350) * 100}%`);
	expect(dq.textContent).toContain("350k compact at");
	expect(dq.all((e) => e.textContent === "↑ Above threshold")).toHaveLength(2);
	dq.querySelector("details")!.open = true;
	for (const fn of dq.all((e) => e.tag === "button" && e.textContent === "Refresh")[0]!.listeners.click ?? [])
		await fn();
	await settle();
	expect(dq.querySelector("details")!.open).toBe(true);
});

test("COMPACT shows compaction in the warning tone, not a hand-off", async () => {
	const h = {
		at: new Date().toISOString(),
		verdict: "COMPACT",
		tokens: 375000,
		replies: 20,
		breaks: 0,
		selfReads: 1,
		threadRereads: 0,
		elevated: ["context"],
		unknown: [],
		report: "Compaction needed",
	};
	const dq = run(() => ({
		items: [],
		health: h,
		healthLimits: { context: 200000, compactContext: 350000, selfReads: 3, threadRereads: 4 },
	}));
	await settle();
	expect(dq.querySelector(".dq-health-badge")!.textContent).toContain("COMPACT");
	expect(dq.textContent).not.toContain("HAND OFF");
	expect(dq.textContent).toContain("350k compact at");
	expect(dq.querySelector(".dq-health")!.style["--health-tone"]).toBe("var(--warning)");
});

test("missing health has no healthy badge or meter", async () => {
	const dq = run(() => ({ items: [], health: null }));
	await settle();
	expect(dq.textContent).toContain("AWAITING DATA");
	expect(dq.all((e) => e.attrs.role === "meter")).toHaveLength(0);
});

test("failed refresh cannot leave a cached OK reading green", async () => {
	let offline = false;
	const dq = run(() => {
		if (offline) throw Error("offline");
		return {
			items: [],
			health: {
				at: new Date().toISOString(),
				verdict: "OK",
				tokens: 100,
				replies: 1,
				breaks: 0,
				selfReads: 0,
				threadRereads: 0,
				unknown: [],
			},
		};
	});
	await settle();
	expect(dq.querySelector(".dq-health-badge")!.textContent).toContain("OK");
	offline = true;
	for (const fn of dq.all((e) => e.tag === "button" && e.textContent === "Refresh")[0]!.listeners.click ?? [])
		await fn();
	await settle();
	expect(dq.querySelector(".dq-health-badge")!.textContent).toContain("LIMITED DATA");
	expect(dq.querySelector(".dq-health")!.style["--health-tone"]).toBe("var(--warning)");
	expect(dq.querySelector(".dq-health-summary")!.textContent).toContain("0k tokens");
});

test("Decisions shows health report and marks old measurements stale", async () => {
	const dq = run(() => ({
		items: [],
		health: { verdict: "HAND OFF", at: "2020-01-01T00:00:00Z", report: "Context: 251000; compact >350000" },
	}));
	await settle();
	expect(dq.textContent).toContain("STALE");
	expect(dq.textContent).toContain("Last known status: HAND OFF");
	expect(dq.textContent).toContain("Context: 251000; compact >350000");
});

test("a refresh redraws an approval whose command changed under the same ID", async () => {
	let current = card("true", "sig-1");
	const dq = run(() => ({ items: [], cards: [current] }));
	await settle();
	const cmd = () => dq.all((e) => e.tag === "pre").map((e) => e.textContent);
	expect(cmd()).toEqual(["true"]);
	current = card("true;", "sig-2");
	const refresh = dq.all((e) => e.textContent === "Refresh" && e.tag === "button")[0]!;
	for (const fn of refresh.listeners.click ?? []) await fn();
	await settle();
	expect(cmd()).toEqual(["true;"]);
	expect(dq.all((e) => e.className.includes("dq-card"))).toHaveLength(1);
});

test("an unchanged card is kept as it is across a refresh, so a pick in progress survives", async () => {
	const dq = run(() => ({ items: [], cards: [card("true", "sig-1")] }));
	await settle();
	const first = dq.all((e) => e.className.includes("dq-card"))[0];
	const refresh = dq.all((e) => e.textContent === "Refresh" && e.tag === "button")[0]!;
	for (const fn of refresh.listeners.click ?? []) await fn();
	await settle();
	expect(dq.all((e) => e.className.includes("dq-card"))[0]).toBe(first!);
});

test("Waiting says which machine can't be reached, and drops the line once it is back", async () => {
	let away = [{ server: "laptop", since: "2026-11-10T14:12:00Z" }];
	const dq = run(() => ({ items: [], cards: [], unreachable: away }));
	await settle();
	expect(dq.textContent).toContain("Laptop not reachable since");
	expect(dq.textContent).toContain("Nothing waiting");
	away = [];
	const refresh = dq.all((e) => e.textContent === "Refresh" && e.tag === "button")[0]!;
	for (const fn of refresh.listeners.click ?? []) await fn();
	await settle();
	expect(dq.textContent).not.toContain("not reachable");
});

test("context bullets render as one list with the prefix stripped", async () => {
	const dq = await ctxOf("Intro\n- a\n- b");
	const uls = dq.all((e) => e.tag === "ul");
	expect(uls).toHaveLength(1);
	expect(uls[0]!.children.map((li) => li.tag)).toEqual(["li", "li"]);
	expect(uls[0]!.children.map((li) => li.textContent)).toEqual(["a", "b"]);
	expect(dq.all((e) => e.tag === "p").map((p) => p.textContent)).toEqual(["Intro"]);
});

test("context bullet text is never parsed as markup", async () => {
	const dq = await ctxOf("Intro\n- <img src=x onerror=alert(1)>");
	expect(dq.all((e) => e.tag === "img" && e.src === "")).toHaveLength(0);
	expect(dq.all((e) => e.tag === "li")[0]!.textContent).toBe("<img src=x onerror=alert(1)>");
});

test("single-line context renders exactly as a plain block, even if it starts with a dash", async () => {
	for (const text of ["Just one line", "- not a list"]) {
		const dq = await ctxOf(text);
		const ctx = dq.querySelector(".dq-ctx")!;
		expect(ctx.tag).toBe("div");
		expect(ctx.children).toHaveLength(0);
		expect(ctx.textContent).toBe(text);
		expect(dq.all((e) => e.tag === "ul")).toHaveLength(0);
	}
});

test("a paragraph line after a list is its own paragraph after the list", async () => {
	const ctx = (await ctxOf("- a\nTail")).querySelector(".dq-ctx")!;
	expect(ctx.children.map((c) => c.tag)).toEqual(["ul", "p"]);
	expect(ctx.children[1]!.textContent).toBe("Tail");
});

test("a mirrored card or approval is shown read-only: no option to pick, no button, no request to answer it", async () => {
	const calls: { method: string; path: string }[] = [];
	const q = { ...card("rm -rf build", "sig-1") };
	const qc = {
		...card("", "sig-2"),
		id: "C-ba9876543210",
		type: "question",
		requestId: "q1",
		options: [{ label: "Yes" }, { label: "No" }],
	};
	const dq = run(() => ({ items: [], cards: [q, qc] }), { calls });
	await settle();
	expect(dq.textContent).toContain("Approvals and goals are answered on the full queue page, never here.");
	expect(dq.textContent).toContain("Answer this question card on the full queue page.");
	// The command is still shown exactly, so it can be read; but nothing here can approve it.
	expect(dq.all((e) => e.tag === "pre").map((e) => e.textContent)).toEqual(["rm -rf build"]);
	expect(dq.all((e) => e.tag === "input")).toHaveLength(0);
	expect(dq.all((e) => e.className.includes("dq-go"))).toHaveLength(0);
	expect(dq.all((e) => e.tag === "a" && e.href === "http://queue.test/")).toHaveLength(2);
	expect(calls.every((c) => c.method === "GET" && INLINE_PATHS.has(c.path))).toBe(true);
});

test("a single-question view reads only the queue and recent answers, never /api/items/<id>", async () => {
	const calls: { method: string; path: string }[] = [];
	const answered = { id: "Q-ctx2", kind: "product", title: "Done one", status: "answered", answer: { label: "A" } };
	const dq = run(() => ({ items: [item("x")] }), {
		src: "http://queue.test/inline.js?item=Q-ctx2",
		calls,
		recent: () => ({ items: [answered] }),
	});
	await settle();
	expect(dq.textContent).toContain("Answered: A.");
	const open = run(() => ({ items: [item("x")] }), { src: "http://queue.test/inline.js?item=Q-ctx1", calls });
	await settle();
	expect(open.all((e) => e.tag === "textarea")).toHaveLength(1);
	expect(calls.length).toBeGreaterThan(0);
	expect(calls.every((c) => c.method === "GET" && INLINE_PATHS.has(c.path))).toBe(true);
});

test("(a) a non-urgent question's card says NOT URGENT; an urgent one does not", async () => {
	const base = {
		kind: "product",
		context: "",
		options: [{ label: "A" }, { label: "B" }],
		status: "open",
		thread: "t",
		server: "s",
		createdAt: new Date().toISOString(),
	};
	const dq = run(() => ({
		items: [
			{ ...base, id: "Q-urg001", title: "Urgent one" },
			{ ...base, id: "Q-nu0001", title: "Can wait", urgent: false },
		],
	}));
	await settle();
	const kinds = dq.all((e) => e.className.split(" ").includes("dq-kind")).map((e) => e.textContent);
	expect(kinds.filter((k) => k.endsWith(" · NOT URGENT"))).toHaveLength(1);
	expect(kinds.some((k) => !k.includes("NOT URGENT"))).toBe(true);
});

test("the view sends the page's key from its own script address on every call, and carries it on the links it makes", async () => {
	const headers: Record<string, string>[] = [];
	const calls: { method: string; path: string }[] = [];
	const KEY = "k-test-0123456789abcdefghijklmnopqrstuvwxyz";
	const it = {
		...item("x"),
		evidence: [{ type: "image", path: "shot.png", caption: "a shot" }],
	};
	const dq = run(() => ({ items: [it] }), {
		src: `http://queue.test/inline.js?view=decisions&k=${KEY}`,
		calls,
		headers,
	});
	await settle();
	expect(calls.length).toBeGreaterThan(0);
	expect(headers).toHaveLength(calls.length);
	expect(headers.every((h) => h["x-decision-token"] === KEY)).toBe(true);
	// an <img> cannot send a header, so its address carries the key
	const imgs = dq.all((e) => e.tag === "img");
	expect(imgs.length).toBeGreaterThan(0);
	expect(imgs.every((i) => i.src.endsWith(`/shot.png?k=${KEY}`))).toBe(true);
});

test("an evidence image or video that does not load (a real failure: the file is gone, the network dropped) is replaced by a note that points to the full page", async () => {
	const it = {
		...item("x"),
		evidence: [
			{ type: "image", path: "shot.png", caption: "a shot" },
			{ type: "video", path: "clip.mp4", caption: "a demo" },
		],
	};
	const dq = run(() => ({ items: [it] }), { src: "http://queue.test/inline.js?view=decisions&k=k-view" });
	await settle();
	for (const tag of ["img", "video"]) (dq.all((e) => e.tag === tag)[0] as unknown as { onerror: () => void }).onerror();
	expect(dq.all((e) => e.tag === "img" || e.tag === "video")).toHaveLength(0);
	expect(dq.textContent).toContain("This image could not load. It shows on the full queue page.");
	expect(dq.textContent).toContain("This video could not load. It shows on the full queue page.");
	// the caption stays with its note
	expect(dq.textContent).toContain("a shot");
});

test("a mirrored card's 'Open the queue page' link carries no key: the script's key is the weak view key, and the browser's own cookie signs it in", async () => {
	const KEY = "k-test-0123456789abcdefghijklmnopqrstuvwxyz";
	const dq = run(() => ({ items: [], cards: [card("rm -rf build", "sig-1")] }), {
		src: `http://queue.test/inline.js?view=decisions&k=${KEY}`,
	});
	await settle();
	expect(dq.all((e) => e.tag === "a" && e.href === "http://queue.test/")).toHaveLength(1);
});
