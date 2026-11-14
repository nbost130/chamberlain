import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { migrateLayout, revertLayout } from "./config-migrate.ts";
import {
	COOKIE_MAX_AGE_S,
	COOKIE_NAME,
	TOKEN_BYTES,
	TOKEN_FILE,
	VIEW_KEY_FILE,
	ensureToken,
	ensureViewKey,
	fileCapability,
	inlineScriptSrc,
	makeCapability,
	newToken,
	pageLink,
	readToken,
	readViewKey,
	rotateToken,
	sameSecret,
	withoutToken,
} from "./capability.ts";

const dirs: string[] = [];
const conf = () => {
	const root = mkdtempSync(`${tmpdir()}/chamberlain-cap-`);
	dirs.push(root);
	const c = `${root}/conf`;
	mkdirSync(c, { mode: 0o700 });
	return c;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const mode = (p: string) => statSync(p).mode & 0o777;
const cookieOf = (setCookie: string) => setCookie.split(";")[0]!;

describe("the token", () => {
	test("is 32 random bytes, as base64url, and never the same twice", () => {
		const a = newToken();
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(Buffer.from(a, "base64url")).toHaveLength(TOKEN_BYTES);
		expect(newToken()).not.toBe(a);
	});
	test("is made on first use in secrets/web-token: mode 0600 in a 0700 directory, and kept after", () => {
		const c = conf();
		const t = ensureToken(c);
		expect(readFileSync(`${c}/secrets/${TOKEN_FILE}`, "utf8")).toBe(`${t}\n`);
		expect(mode(`${c}/secrets/${TOKEN_FILE}`)).toBe(0o600);
		expect(mode(`${c}/secrets`)).toBe(0o700);
		expect(ensureToken(c)).toBe(t);
		expect(readToken(c)).toBe(t);
	});
	test("an empty file left by a crash is an error that says to rotate, and is never replaced; a short one made by hand is too; a loose one is refused", () => {
		const c = conf();
		mkdirSync(`${c}/secrets`, { mode: 0o700 });
		writeFileSync(`${c}/secrets/${TOKEN_FILE}`, "", { mode: 0o600 });
		expect(() => ensureToken(c)).toThrow("rotate-token");
		expect(readFileSync(`${c}/secrets/${TOKEN_FILE}`, "utf8")).toBe(""); // untouched
		writeFileSync(`${c}/secrets/${TOKEN_FILE}`, "short\n", { mode: 0o600 });
		expect(() => ensureToken(c)).toThrow("rotate-token");
		expect(readToken(c)).toBeUndefined();
		const t = rotateToken(c);
		writeFileSync(`${c}/secrets/${TOKEN_FILE}`, `${t}\n`, { mode: 0o644 });
		chmodSync(`${c}/secrets/${TOKEN_FILE}`, 0o644);
		expect(() => ensureToken(c)).toThrow("0600");
	});
	test("a token published by another process between our read and our create is returned as it is: ensureToken never rotates", () => {
		const c = conf();
		let winner = "";
		const got = ensureToken(c, {
			afterMiss: () => {
				// the concurrent winner publishes whole, exactly as ensureToken itself does (a temporary file, hard-linked into place)
				winner = newToken();
				mkdirSync(`${c}/secrets`, { recursive: true, mode: 0o700 });
				writeFileSync(`${c}/secrets/w.tmp`, `${winner}\n`, { mode: 0o600 });
				linkSync(`${c}/secrets/w.tmp`, `${c}/secrets/${TOKEN_FILE}`);
				rmSync(`${c}/secrets/w.tmp`);
			},
		});
		expect(got).toBe(winner);
		expect(readFileSync(`${c}/secrets/${TOKEN_FILE}`, "utf8").trim()).toBe(winner);
	});
	test("a file that is momentarily empty is read again, and the token another process writes into it is returned", async () => {
		const c = conf();
		mkdirSync(`${c}/secrets`, { mode: 0o700 });
		writeFileSync(`${c}/secrets/${TOKEN_FILE}`, "", { mode: 0o600 });
		const token = newToken();
		const p = Bun.spawn(
			[
				"bun",
				"-e",
				`await Bun.sleep(150); require("node:fs").writeFileSync(process.argv[1], process.argv[2] + "\\n")`,
				`${c}/secrets/${TOKEN_FILE}`,
				token,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(ensureToken(c)).toBe(token); // blocks, reading again, until the writer has written
		await p.exited;
	});
	test("eight processes released together by a barrier, over ten rounds: every one returns the token that is on disk, and none rotates it", async () => {
		const mod = new URL("./capability.ts", import.meta.url).pathname;
		for (let round = 0; round < 10; round++) {
			const c = conf();
			const go = `${c}/../go`;
			// Each child imports the module, then spins until the barrier file appears, so all eight call ensureToken in the same few microseconds.
			const script = `import { existsSync } from "node:fs"; import { ensureToken } from ${JSON.stringify(mod)}; const [c, go] = process.argv.slice(1); while (!existsSync(go)); process.stdout.write(ensureToken(c));`;
			const procs = Array.from({ length: 8 }, () =>
				Bun.spawn(["bun", "-e", script, c, go], { stdout: "pipe", stderr: "pipe", env: process.env }),
			);
			await Bun.sleep(150); // let every child reach the barrier
			writeFileSync(go, "");
			const outs = await Promise.all(
				procs.map(async (p) => ({
					out: await new Response(p.stdout).text(),
					err: await new Response(p.stderr).text(),
					code: await p.exited,
				})),
			);
			for (const o of outs) expect(o.code, `round ${round}: ${o.err}`).toBe(0);
			const onDisk = readFileSync(`${c}/secrets/${TOKEN_FILE}`, "utf8").trim();
			expect(onDisk, `round ${round}`).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect([...new Set(outs.map((o) => o.out))], `round ${round}`).toEqual([onDisk]);
			expect(readdirSync(`${c}/secrets`), `round ${round}`).toEqual([TOKEN_FILE]); // no temporary file is left behind
		}
	}, 60_000); // starts eighty child processes in ten barrier rounds: 5.0 s seen under load, so the 5 s default flakes
	test("rotating replaces it, 0600, and a running capability follows without a restart", () => {
		const c = conf();
		const old = ensureToken(c);
		const cap = fileCapability(c);
		expect(cap.accepts(old)).toBe(true);
		const fresh = rotateToken(c);
		expect(fresh).not.toBe(old);
		expect(mode(`${c}/secrets/${TOKEN_FILE}`)).toBe(0o600);
		expect(cap.accepts(old)).toBe(false);
		expect(cap.accepts(fresh)).toBe(true);
	});
	test("no token, an unreadable one or a loose one accepts nothing: the page fails closed", () => {
		const c = conf();
		const cap = fileCapability(c);
		expect(cap.accepts("anything")).toBe(false);
		expect(cap.acceptsCookie(`${COOKIE_NAME}=v1.9999999999.${"a".repeat(64)}`)).toBe(false);
		expect(() => cap.grant(false)).toThrow();
		const t = ensureToken(c);
		chmodSync(`${c}/secrets/${TOKEN_FILE}`, 0o644);
		expect(fileCapability(c).accepts(t)).toBe(false);
	});
});

describe("the view key", () => {
	test("is its own secret, made like the token (0600, in secrets/view-key), distinct from it, and kept after", () => {
		const c = conf();
		const t = ensureToken(c);
		const v = ensureViewKey(c);
		expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(v).not.toBe(t);
		expect(readFileSync(`${c}/secrets/${VIEW_KEY_FILE}`, "utf8")).toBe(`${v}\n`);
		expect(mode(`${c}/secrets/${VIEW_KEY_FILE}`)).toBe(0o600);
		expect(ensureViewKey(c)).toBe(v);
		expect(readViewKey(c)).toBe(v);
		expect(readToken(c)).toBe(t); // making it left the page's token alone
	});
	test("a rotation of the page's token leaves it alone; a short or empty file is never replaced and the error does not point at rotate-token", () => {
		const c = conf();
		ensureToken(c);
		const v = ensureViewKey(c);
		rotateToken(c);
		expect(readViewKey(c)).toBe(v);
		writeFileSync(`${c}/secrets/${VIEW_KEY_FILE}`, "short\n", { mode: 0o600 });
		expect(() => ensureViewKey(c)).toThrow(`remove secrets/${VIEW_KEY_FILE}`);
		expect(readViewKey(c)).toBeUndefined();
		expect(readFileSync(`${c}/secrets/${VIEW_KEY_FILE}`, "utf8")).toBe("short\n"); // untouched
	});
	test("acceptsView takes the view key and nothing else: not the page's token, not a cookie, not a wrong or empty one", () => {
		const T = "t".repeat(43);
		const V = "v".repeat(43);
		const cap = makeCapability(
			() => T,
			() => 1_800_000_000_000,
			() => V,
		);
		expect(cap.acceptsView(V)).toBe(true);
		expect(cap.accepts(V)).toBe(false);
		expect(cap.acceptsView(T)).toBe(false);
		expect(cap.accepts(T)).toBe(true);
		for (const bad of [undefined, null, "", "v".repeat(42)]) expect(cap.acceptsView(bad)).toBe(false);
		expect(cap.acceptsCookie(cookieOf(cap.grant(false)))).toBe(true);
		expect(makeCapability(() => T).acceptsView(V)).toBe(false); // no view key to hold
	});
	test("the file capability follows both files, and a loose view key accepts nothing", () => {
		const c = conf();
		const t = ensureToken(c);
		const v = ensureViewKey(c);
		const cap = fileCapability(c);
		expect(cap.accepts(t)).toBe(true);
		expect(cap.acceptsView(v)).toBe(true);
		expect(cap.acceptsView(t)).toBe(false);
		chmodSync(`${c}/secrets/${VIEW_KEY_FILE}`, 0o644);
		expect(cap.acceptsView(v)).toBe(false);
		expect(cap.accepts(t)).toBe(true);
	});
	test("a post's script address takes whatever key it is given, URL-encoded, and nothing else", () => {
		expect(inlineScriptSrc("http://q.test/", "a b+/", "Q-abcd")).toBe(
			"http://q.test/inline.js?view=decisions&item=Q-abcd&k=a%20b%2B%2F",
		);
	});
});

describe("comparing", () => {
	test("sameSecret is equality for strings of any length, empty and absent included", () => {
		expect(sameSecret("abc", "abc")).toBe(true);
		expect(sameSecret("abc", "abd")).toBe(false);
		expect(sameSecret("abc", "abcd")).toBe(false);
		expect(sameSecret("", "abc")).toBe(false);
		const cap = makeCapability(() => "t".repeat(43));
		expect(cap.accepts(undefined)).toBe(false);
		expect(cap.accepts(null)).toBe(false);
		expect(cap.accepts("")).toBe(false);
	});
	test("the source compares a token only through timingSafeEqual", () => {
		const src = readFileSync(new URL("./capability.ts", import.meta.url), "utf8");
		expect(src).toContain("timingSafeEqual");
		// nothing compares a secret with === or ==: not the token, not a cookie's signature
		const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
		expect(code).not.toMatch(/\btoken\s*[!=]==|[!=]==\s*token\b|\bm\[2\]!?\s*[!=]==|[!=]==\s*sign\(/);
		const app = readFileSync(new URL("../web/app.ts", import.meta.url), "utf8");
		expect(app).not.toMatch(/TOKEN_HEADER\)\s*[!=]==?|TOKEN_PARAM\)\s*[!=]==?/);
	});
});

describe("the cookie", () => {
	const T = "k".repeat(43);
	test("a granted cookie is accepted, carries no token, and is long-lived, HttpOnly and not sent cross-site", () => {
		const cap = makeCapability(() => T);
		const sc = cap.grant(false);
		expect(sc).not.toContain(T);
		expect(sc).toContain("HttpOnly");
		expect(sc).toContain("SameSite=Lax");
		expect(sc).toContain(`Max-Age=${COOKIE_MAX_AGE_S}`);
		expect(sc).not.toContain("Secure");
		expect(cap.grant(true)).toContain("; Secure");
		expect(cap.acceptsCookie(`a=b; ${cookieOf(sc)}; c=d`)).toBe(true);
	});
	test("it expires, and a tampered one, another token's and a rotation's are refused", () => {
		const clock = { now: 1_800_000_000_000 };
		let token = T;
		const cap = makeCapability(
			() => token,
			() => clock.now,
		);
		const c = cookieOf(cap.grant(false));
		expect(cap.acceptsCookie(c)).toBe(true);
		const [name, value] = c.split("=") as [string, string];
		const parts = value.split(".");
		expect(cap.acceptsCookie(`${name}=${parts[0]}.${Number(parts[1]) + 1}.${parts[2]}`)).toBe(false); // a later expiry, same signature
		expect(cap.acceptsCookie(`${name}=${parts[0]}.${parts[1]}.${"0".repeat(64)}`)).toBe(false);
		expect(cap.acceptsCookie(`${name}=garbage`)).toBe(false);
		expect(
			makeCapability(
				() => "z".repeat(43),
				() => clock.now,
			).acceptsCookie(c),
		).toBe(false);
		clock.now += (COOKIE_MAX_AGE_S + 1) * 1000;
		expect(cap.acceptsCookie(c)).toBe(false);
		clock.now -= (COOKIE_MAX_AGE_S + 1) * 1000;
		token = "r".repeat(43); // rotated
		expect(cap.acceptsCookie(c)).toBe(false);
	});
});

describe("links carry the token", () => {
	test("the page link and the inline script address end in ?k= / &k=, and never double a slash", () => {
		expect(pageLink("http://h:1", "TOK")).toBe("http://h:1/?k=TOK");
		expect(pageLink("http://h:1/", "TOK", "/rulings")).toBe("http://h:1/rulings?k=TOK");
		expect(inlineScriptSrc("http://h:1", "TOK")).toBe("http://h:1/inline.js?view=decisions&k=TOK");
		expect(inlineScriptSrc("http://h:1/", "TOK", "Q-abcd")).toBe(
			"http://h:1/inline.js?view=decisions&item=Q-abcd&k=TOK",
		);
	});
	test("withoutToken removes the token, raw or encoded, from a message", () => {
		expect(withoutToken("sent http://h/?k=TOK%2Fx and TOK", "TOK")).toBe("sent http://h/?k=[token]%2Fx and [token]");
		expect(withoutToken("nothing", undefined)).toBe("nothing");
	});
});

test("the token file is not a path anything else makes: nothing in a fresh config directory but secrets/web-token", () => {
	const c = conf();
	ensureToken(c);
	expect(existsSync(`${c}/secrets/${TOKEN_FILE}`)).toBe(true);
	expect(existsSync(`${c}/${TOKEN_FILE}`)).toBe(false);
});

test("a revert of the config migration leaves the page's token where it is: it is a secret with no old name", () => {
	const c = conf();
	writeFileSync(`${c}/wake-url`, "https://fake.example/hook\n", { mode: 0o600 });
	migrateLayout(c);
	const t = ensureToken(c);
	revertLayout(c);
	expect(readFileSync(`${c}/secrets/${TOKEN_FILE}`, "utf8").trim()).toBe(t);
	expect(existsSync(`${c}/${TOKEN_FILE}`)).toBe(false);
	expect(readFileSync(`${c}/wake-url`, "utf8").trim()).toBe("https://fake.example/hook");
	// a migration run again does not mistake it for an old file, and a rotation after a revert still works
	expect(migrateLayout(c).plan.secrets.map((s) => s.name)).toEqual(["wake-url"]);
	expect(rotateToken(c)).not.toBe(t);
});
