import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
	COOKIE_MAX_AGE_S,
	COOKIE_NAME,
	TOKEN_BYTES,
	TOKEN_FILE,
	ensureToken,
	fileCapability,
	inlineScriptSrc,
	makeCapability,
	newToken,
	pageLink,
	readToken,
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
	test("an empty file left by a crash is replaced, a short one made by hand is an error, and a loose one is refused", () => {
		const c = conf();
		mkdirSync(`${c}/secrets`, { mode: 0o700 });
		writeFileSync(`${c}/secrets/${TOKEN_FILE}`, "", { mode: 0o600 });
		expect(ensureToken(c)).toMatch(/^[A-Za-z0-9_-]{43}$/);
		writeFileSync(`${c}/secrets/${TOKEN_FILE}`, "short\n", { mode: 0o600 });
		expect(() => ensureToken(c)).toThrow("rotate-token");
		expect(readToken(c)).toBeUndefined();
		const t = rotateToken(c);
		writeFileSync(`${c}/secrets/${TOKEN_FILE}`, `${t}\n`, { mode: 0o644 });
		chmodSync(`${c}/secrets/${TOKEN_FILE}`, 0o644);
		expect(() => ensureToken(c)).toThrow("0600");
	});
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
