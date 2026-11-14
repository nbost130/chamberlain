/** The smoke test's checks of the page: `web --test` started from the binary, its keys and refusals, its static files, and a question asked by another process. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { bin, check, conf, empty, env, exec, port, ROOT, state } from "./smoke-lib.ts";

/** The page under test: where it listens, its two keys, and the header that carries the page key. */
type Site = { base: string; token: string; viewKey: string; key: Record<string, string> };

/** The page, from the embedded files; true once it said where it listens. */
async function startPage(): Promise<ReturnType<typeof Bun.spawn>> {
	const page = Bun.spawn([bin, "web", "--test"], { cwd: empty, env, stdout: "pipe", stderr: "pipe" });
	const reader = (page.stdout as ReadableStream<Uint8Array>).getReader();
	let out = "";
	const deadline = Date.now() + 15_000;
	while (!out.includes("decision queue on") && Date.now() < deadline) {
		const { value, done } = await reader.read();
		if (done) break;
		out += new TextDecoder().decode(value);
	}
	check(
		"web --test starts",
		out.includes(`http://127.0.0.1:${port}`),
		out || (await new Response(page.stderr as ReadableStream<Uint8Array>).text()),
	);
	return page;
}

/** The page's capability token and view key: made at its first start, in secrets/. Without them nothing but the static code is served. */
function readKeys(): Site {
	const base = `http://127.0.0.1:${port}`;
	const tokenFile = join(conf, "secrets", "web-token");
	const token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
	check(
		"the page made its capability token (43 characters, mode 0600)",
		token.length === 43 && (statSync(tokenFile).mode & 0o777) === 0o600,
	);
	const viewFile = join(conf, "secrets", "view-key");
	const viewKey = existsSync(viewFile) ? readFileSync(viewFile, "utf8").trim() : "";
	check(
		"the page made its view key too (43 characters, mode 0600, not the page key)",
		viewKey.length === 43 && viewKey !== token && (statSync(viewFile).mode & 0o777) === 0o600,
	);
	return { base, token, viewKey, key: { "x-decision-token": token } };
}

/** A header-only request with no Origin is inline authority: it reads the queue, and nothing else. */
async function checkRefusals({ base, token, viewKey }: Site) {
	const nokey = await fetch(`${base}/api/queue`);
	check("GET /api/queue with no key is 401", nokey.status === 401, `status ${nokey.status}`);
	const nullNoKey = await fetch(`${base}/api/queue`, { headers: { origin: "null" } });
	check("a null-origin GET /api/queue with no key is 401", nullNoKey.status === 401, `status ${nullNoKey.status}`);
	const noOriginItem = await fetch(`${base}/api/items/Q-abcd`, { headers: { "x-decision-token": viewKey } });
	check(
		"the view key with no Origin cannot read one item (403)",
		noOriginItem.status === 403,
		`status ${noOriginItem.status}`,
	);
	const wrong = await fetch(`${base}/api/queue`, { headers: { "x-decision-token": `${token.slice(0, -1)}x` } });
	check("a wrong key is 401", wrong.status === 401, `status ${wrong.status}`);
}

/** The page's link: the 401 page that says how to get one, the 303 that sets the cookie, and `chamberlain web link`. */
async function checkLinks({ base, token, viewKey }: Site) {
	const locked = await fetch(`${base}/`);
	check(
		"GET / with no key is the 401 'needs its link' page",
		locked.status === 401 && (await locked.text()).includes("chamberlain web link"),
	);
	const linked = await fetch(`${base}/?k=${token}`, { redirect: "manual" });
	check(
		"GET /?k=<key> is a 303 to / that sets the cookie",
		linked.status === 303 &&
			linked.headers.get("location") === "/" &&
			(linked.headers.get("set-cookie") ?? "").startsWith("dq_cap="),
		`status ${linked.status}`,
	);
	const link = exec("web", "link");
	check(
		"`chamberlain web link` prints the page link and the inline script address with the key",
		link.exitCode === 0 &&
			link.stdout.toString().includes(`/?k=${token}`) &&
			link.stdout.toString().includes(`inline.js?view=decisions&amp;k=${viewKey}`) &&
			!link.stdout.toString().includes(`inline.js?view=decisions&amp;k=${token}`),
		`exit ${link.exitCode}: ${link.stderr}`,
	);
}

/** Each static file the page serves is what src/web/static/ holds, byte for byte. */
async function checkStaticFiles({ base, key }: Site) {
	const files: [string, string, string][] = [
		["/", "index.html", "text/html"],
		["/app.css", "app.css", "text/css"],
		["/app.js", "app.js", "text/javascript"],
		["/inline.js", "inline.js", "text/javascript"],
	];
	for (const [url, file, type] of files) {
		const r = await fetch(base + url, { headers: key });
		const body = new Uint8Array(await r.arrayBuffer());
		const want = new Uint8Array(readFileSync(join(ROOT, "src/web/static", file)));
		check(
			`GET ${url} is 200 ${type} and is src/web/static/${file} byte for byte (${body.length} bytes)`,
			r.status === 200 && (r.headers.get("content-type") ?? "").startsWith(type) && Buffer.compare(body, want) === 0,
			`status ${r.status}, type ${r.headers.get("content-type")}, ${body.length} bytes vs ${want.length}`,
		);
	}
}

/** A question asked by one process (the CLI) is read back from the database by another (the page); returns its id. */
async function askAndReadBack({ base, key }: Site): Promise<string | undefined> {
	const q = JSON.stringify({
		kind: "product",
		title: "Smoke: which colour?",
		context: "- asked by scripts/smoke.ts",
		options: [{ label: "Blue" }, { label: "Green" }],
		thread: "Smoke",
		server: "main",
		urgent: false,
	});
	const a = exec("ask", q);
	const id = a.stdout.toString().match(/\bQ-[a-z0-9]{4,16}\b/)?.[0];
	check(
		"ask files the question into the scratch state directory",
		a.exitCode === 0 && id !== undefined,
		`exit ${a.exitCode}: ${a.stdout}${a.stderr}`,
	);
	check("ask wrote the database under the scratch state dir", existsSync(join(state, "chamberlain.db")));
	const queue = await (await fetch(`${base}/api/queue`, { headers: key })).text();
	check(
		"the page (another process) reads that question back from the database",
		id !== undefined && queue.includes(id) && queue.includes("Smoke: which colour?"),
		queue.slice(0, 300),
	);
	return id;
}

/** Snooze, un-snooze and dismiss through the built page: state changes need the key from the page's own origin, and a frame is refused. */
async function checkStateChanges({ base, key }: Site, id: string | undefined) {
	const lists = async () => {
		const body = (await (await fetch(`${base}/api/queue`, { headers: key })).json()) as {
			items: { id: string }[];
			snoozed: { id: string }[];
		};
		return { active: body.items.some((i) => i.id === id), later: body.snoozed.some((i) => i.id === id) };
	};
	const act = (route: string, body: unknown, origin = base) =>
		fetch(`${base}/api/items/${id}/${route}`, {
			method: "POST",
			headers: { ...key, origin, "content-type": "application/json", "x-decision-queue": "1" },
			body: JSON.stringify(body),
		});
	const until = new Date(Date.now() + 3_600_000).toISOString();
	const frame = await act("snooze", { until }, "null");
	check("an inline frame holding the key cannot snooze (403)", frame.status === 403, `status ${frame.status}`);
	const snoozed = await act("snooze", { until });
	const afterSnooze = await lists();
	check(
		"snooze moves the question to the Snoozed list, off the active one",
		snoozed.status === 200 && !afterSnooze.active && afterSnooze.later,
		`status ${snoozed.status} ${JSON.stringify(afterSnooze)}`,
	);
	const unsnoozed = await act("unsnooze", {});
	const afterUnsnooze = await lists();
	check(
		"un-snooze puts it back on the active list at once",
		unsnoozed.status === 200 && afterUnsnooze.active && !afterUnsnooze.later,
		`status ${unsnoozed.status} ${JSON.stringify(afterUnsnooze)}`,
	);
	const dismissed = await act("dismiss", { note: "smoke" });
	const afterDismiss = await lists();
	check(
		"dismiss takes the question off both lists",
		dismissed.status === 200 && !afterDismiss.active && !afterDismiss.later,
		`status ${dismissed.status} ${JSON.stringify(afterDismiss)}`,
	);
}

/** The page from the binary: started, its keys and refusals, its files, and a question asked by another process. */
export async function smokeWeb() {
	const page = await startPage();
	try {
		const site = readKeys();
		await checkRefusals(site);
		await checkLinks(site);
		await checkStaticFiles(site);
		const id = await askAndReadBack(site);
		await checkStateChanges(site, id);
	} finally {
		page.kill();
		await page.exited;
	}
}
