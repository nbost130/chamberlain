/**
 * The capability token of the decision-queue page: one random secret per install that every request must prove it holds.
 *
 * T3 shows inline views in a sandboxed frame whose origin is "null", so the page answers null-origin requests for the three reads and the
 * answer an inline view makes (src/web/app.ts). Without a secret, any sandboxed page that can reach the port could read the queue and
 * answer for the operator. The token closes that, and the same token closes the page to anything else that can reach the port:
 *
 *   - 32 random bytes (base64url), made on first start, kept in `secrets/web-token` (mode 0600, src/core/layout.ts);
 *   - the page link `chamberlain web link` prints carries it (`?k=<token>`). It never goes into a Decisions post: a post carries the VIEW key
 *     (`secrets/view-key`, VIEW_KEY_FILE), a second secret that buys only what an inline frame may do;
 *   - an inline frame sends the view key as the `x-decision-token` header (a frame holds no cookie we accept);
 *   - the token in that header, from a request with no Origin (curl, an agent) or from a null-origin frame, also gets inline authority only: full
 *     authority is the cookie, a same-origin request, or `?k=` on a page load (src/web/app.ts);
 *   - a browser that opens a `?k=` link gets a long-lived cookie (`dq_cap`), HMAC-signed with a key derived from the token, so the cookie
 *     carries no token and dies the moment the token is rotated, and the address bar loses the key (a 303 to the same path without it);
 *   - tokens are compared in constant time, and never logged, never written to the events table and never put in an error message;
 *   - `chamberlain web rotate-token` replaces the file: every old link, cookie and already-rendered view stops working at once.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { linkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { holdFlock, RelayLockUnavailableError } from "./flock.ts";
import { ensureSecretsDir, readSecret } from "./layout.ts";
import { SECRETS_DIR } from "./layout-schema.ts";

/** The secret's name in `secrets/`. */
export const TOKEN_FILE = "web-token";
/**
 * The view key: a second secret, made the same way, that goes into the Decisions thread's posts INSTEAD of the page key. A post is copied
 * into the thread's messages, its tool input and its provider transcript, where any agent that can read the thread can read it, so what it
 * carries must be the weakest secret the install has. The page accepts it only for what an inline frame may do (inlineVerdict in
 * src/web/app.ts: three reads and a plain answer), whatever the Origin, and never for a cookie, a page load, evidence, a card or a ruling.
 */
export const VIEW_KEY_FILE = "view-key";
export const TOKEN_BYTES = 32;
/** The cookie a browser holds after it opens a link, and how long it lasts (400 days: the longest a browser keeps one). */
export const COOKIE_NAME = "dq_cap";
export const COOKIE_MAX_AGE_S = 400 * 24 * 3600;
/** The header an inline frame sends, and the query parameter every link carries. */
export const TOKEN_HEADER = "x-decision-token";
export const TOKEN_PARAM = "k";
const MIN_TOKEN_CHARS = 32;

/** A fresh token: 32 random bytes as base64url (43 characters). */
export const newToken = (): string => randomBytes(TOKEN_BYTES).toString("base64url");

const digest = (s: string) => createHash("sha256").update(s).digest();
/** Constant-time equality for two strings of any length (both are hashed to the same length first). */
export const sameSecret = (a: string, b: string): boolean => timingSafeEqual(digest(a), digest(b));

/** What the page asks of its capability. Tests give it their own (src/testing/capability.ts). */
export type Capability = {
	/** True when `candidate` is this install's token. Constant time; false for an absent one and when there is no token yet. */
	accepts(candidate: string | null | undefined): boolean;
	/** True when `candidate` is this install's view key (the weak one a post carries). It is never the page key, and grants only inline authority. */
	acceptsView(candidate: string | null | undefined): boolean;
	/** True when the Cookie header holds a valid, unexpired `dq_cap` cookie signed by the current token. */
	acceptsCookie(cookieHeader: string | null | undefined): boolean;
	/** The Set-Cookie value that gives a browser the capability: signed, carries no token. */
	grant(secure: boolean): string;
};

const cookieKey = (token: string) => createHmac("sha256", token).update("chamberlain-cookie-v1").digest();
const sign = (token: string, exp: number) =>
	createHmac("sha256", cookieKey(token)).update(`${COOKIE_NAME}.v1.${exp}`).digest("hex");

/** Is this one `name=value` part of a Cookie header an unexpired `dq_cap` cookie signed by `token`? */
function cookiePartValid(part: string, token: string, nowMs: number): boolean {
	const [k, ...v] = part.trim().split("=");
	if (k !== COOKIE_NAME) return false;
	const m = /^v1\.(\d{1,12})\.([0-9a-f]{64})$/.exec(v.join("="));
	if (!m) return false;
	const [, expText, mac] = m;
	if (expText === undefined || mac === undefined) throw Error("the cookie pattern matched without its two groups");
	const exp = Number(expText);
	if (exp * 1000 <= nowMs) return false;
	return sameSecret(mac, sign(token, exp));
}

/** A capability over a token that `read` supplies on each call (the file may be rotated under a running page). `now` is the clock. */
export function makeCapability(
	read: () => string | undefined,
	now: () => number = Date.now,
	readView: () => string | undefined = () => undefined,
): Capability {
	return {
		accepts(candidate) {
			const token = read();
			if (!token || typeof candidate !== "string" || candidate === "") return false;
			return sameSecret(candidate, token);
		},
		acceptsView(candidate) {
			const view = readView();
			if (!view || typeof candidate !== "string" || candidate === "") return false;
			return sameSecret(candidate, view);
		},
		acceptsCookie(header) {
			const token = read();
			if (!token) return false;
			return (header ?? "").split(";").some((part) => cookiePartValid(part, token, now()));
		},
		grant(secure) {
			const token = read();
			if (!token) throw Error("the page has no token to grant a cookie for");
			const exp = Math.floor(now() / 1000) + COOKIE_MAX_AGE_S;
			// Lax, not Strict: a link opened from another app is a cross-site navigation, and Strict would hold the cookie back from it. Lax
			// still keeps it out of every cross-site subrequest and POST, and the page's answers are POSTs behind more checks than this one.
			return `${COOKIE_NAME}=v1.${exp}.${sign(token, exp)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_S}${secure ? "; Secure" : ""}`;
		},
	};
}

// ---- the token on disk ---------------------------------------------------------------------------------

/** The token in `<conf>/secrets/web-token`, or undefined when there is none. A file that is not a private regular file throws (readSecret). */
export function readToken(conf: string): string | undefined {
	const t = readSecret(conf, TOKEN_FILE);
	return t && t.length >= MIN_TOKEN_CHARS ? t : undefined;
}

/**
 * The view key in `<conf>/secrets/view-key`, or undefined when there is none. Same rules as readToken, plus one: a view key that holds the SAME
 * value as the page's token (a symlink, a copy) is no view key at all, because it would hand the page's authority to every post.
 */
export function readViewKey(conf: string): string | undefined {
	const t = readSecret(conf, VIEW_KEY_FILE);
	if (!t || t.length < MIN_TOKEN_CHARS) return undefined;
	let page: string | undefined;
	try {
		page = readSecret(conf, TOKEN_FILE);
	} catch {
		page = undefined; // an unreadable page token is refused by the page itself
	}
	return page !== undefined && sameSecret(t, page) ? undefined : t;
}

/**
 * The token, made now if the install has none: published atomically (a complete file, hard-linked into place, so two starting processes get the same one), mode 0600. It NEVER
 * replaces a file that exists: one that stays empty or short (a crash, or written by hand) is an error that says to run `chamberlain web rotate-token`.
 */
export const ensureToken = (conf: string, seam: { afterMiss?: () => void } = {}): string =>
	ensureSecret(conf, TOKEN_FILE, seam);
/** The view key, made now if the install has none, the same way and with the same never-replace rule as the page's token. */
export function ensureViewKey(conf: string, seam: { afterMiss?: () => void } = {}): string {
	const v = ensureSecret(conf, VIEW_KEY_FILE, seam);
	if (readViewKey(conf) === undefined)
		throw Error(`${SECRETS_DIR}/${VIEW_KEY_FILE} holds the page's own token: ${fixFor(VIEW_KEY_FILE)}`);
	return v;
}

function ensureSecret(conf: string, file: string, seam: { afterMiss?: () => void }): string {
	const dir = ensureSecretsDir(conf);
	const p = `${dir}/${file}`;
	const have = readSecret(conf, file);
	if (have) return checked(have, file);
	seam.afterMiss?.(); // a test seam: where a concurrent process can publish its token, after our read found none
	if (!statSafe(p)) {
		// Published whole or not at all: the token is written to a file of its own and HARD-LINKED to its name, which fails if the name exists. A
		// process that finds the name therefore finds a complete token, and two processes starting together end up with the same one.
		const token = newToken();
		const tmp = `${dir}/${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
		writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
		try {
			linkSync(tmp, p);
			return token;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; // someone else got there first: take theirs, below
		} finally {
			rmSync(tmp, { force: true });
		}
	}
	// The file exists, made by another process or left by one that crashed. ensureSecret NEVER replaces it (rotating over a winner's file hands the
	// loser a token the disk no longer holds): read it, a few times if it is momentarily empty, and if it stays unusable say so. Only
	// `chamberlain web rotate-token` replaces a token.
	for (let i = 0; i < 20; i++) {
		const t = readSecret(conf, file);
		if (t) return checked(t, file);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
	}
	throw Error(`${SECRETS_DIR}/${file} exists but holds no key: ${fixFor(file)}`);
}
// The page's token has a command that replaces it. The view key has none yet: remove the file and start the page, which makes a new one.
const fixFor = (file: string) =>
	file === TOKEN_FILE ? "run `chamberlain web rotate-token`" : `remove ${SECRETS_DIR}/${file} and start the page again`;
const checked = (t: string, file: string): string => {
	if (t.length < MIN_TOKEN_CHARS)
		throw Error(`${SECRETS_DIR}/${file} holds fewer than ${MIN_TOKEN_CHARS} characters: ${fixFor(file)}`);
	return t;
};
const statSafe = (p: string) => {
	try {
		return statSync(p);
	} catch {
		return undefined;
	}
};

/** Replaces the token with a new one, through a temporary file and a rename (a reader sees the old file or the new one, never half). Returns it. */
export function rotateToken(conf: string): string {
	const dir = ensureSecretsDir(conf);
	// Under the config directory's lock, so two rotations (or a rotation and a migration) cannot interleave; on a platform with no flock it goes ahead without.
	let lock: { release(): void } | undefined;
	try {
		lock = holdFlock(conf, { waitMs: 10_000 });
	} catch (e) {
		if (!(e instanceof RelayLockUnavailableError)) throw e;
	}
	try {
		const token = newToken();
		const tmp = `${dir}/${TOKEN_FILE}.tmp-${process.pid}`;
		writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
		renameSync(tmp, `${dir}/${TOKEN_FILE}`);
		return token;
	} finally {
		lock?.release();
	}
}

/**
 * A capability over the token file, re-read when the file changes (rotation replaces it by rename, so a running page follows it
 * without a restart). A missing, unreadable or short token accepts nothing: the page fails closed.
 */
export function fileCapability(conf: string, now: () => number = Date.now): Capability {
	return makeCapability(fileReader(conf, TOKEN_FILE, readToken), now, fileReader(conf, VIEW_KEY_FILE, readViewKey));
}

/** A reader of one secret file that re-reads it only when the file changes (a replacement by rename shows as a new inode or time). */
function fileReader(conf: string, file: string, load: (conf: string) => string | undefined): () => string | undefined {
	let seen: { key: string; token: string | undefined } | undefined;
	return () => {
		const p = `${conf}/${SECRETS_DIR}/${file}`;
		let key: string;
		try {
			const st = statSync(p);
			key = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
		} catch {
			seen = undefined;
			return undefined;
		}
		if (seen?.key !== key) {
			let token: string | undefined;
			try {
				token = load(conf);
			} catch {
				token = undefined; // a file that is not 0600 is not trusted: nothing is accepted until it is fixed
			}
			seen = { key, token };
		}
		return seen.token;
	};
}

// ---- the links ---------------------------------------------------------------------------------------------

/** The page's address with the key on it: `<base>/?k=<token>`, or another path. Opening it in a browser sets the cookie. */
export const pageLink = (base: string, token: string, path = "/"): string =>
	`${base.replace(/\/+$/, "")}${path}${path.includes("?") ? "&" : "?"}${TOKEN_PARAM}=${encodeURIComponent(token)}`;

/**
 * The script address of the Decisions thread's inline view: `<base>/inline.js?view=decisions[&item=Q-…]&k=<view key>`. The key in it is the VIEW
 * key, never the page's token: this address is copied into the thread (see VIEW_KEY_FILE).
 */
export function inlineScriptSrc(base: string, viewKey: string, item?: string): string {
	const q = [`view=decisions`, ...(item ? [`item=${item}`] : []), `${TOKEN_PARAM}=${encodeURIComponent(viewKey)}`];
	return `${base.replace(/\/+$/, "")}/inline.js?${q.join("&")}`;
}

/** Pure: `s` with every occurrence of `token` replaced, for a message that may have come to hold one. */
export const withoutToken = (s: string, token: string | undefined): string =>
	token ? s.split(token).join("[token]").split(encodeURIComponent(token)).join("[token]") : s;

/** Every spelling of `token` a text could hold: raw, URL-encoded, and every character as `%XX` (either case of the hex digits). */
const spellings = (token: string): string[] => {
	const pct = [...Buffer.from(token, "utf8")].map((b) => `%${b.toString(16).padStart(2, "0")}`).join("");
	return [token, encodeURIComponent(token), pct, pct.toUpperCase()];
};
/** Pure: true when `s` holds `token` in any spelling `spellings` knows. For a guard on what may be sent; withoutToken is for what comes back. */
export const holdsToken = (s: string, token: string | undefined): boolean =>
	Boolean(token) && spellings(token as string).some((x) => s.includes(x));
