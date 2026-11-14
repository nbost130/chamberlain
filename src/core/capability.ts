/**
 * The capability token of the decision-queue page: one random secret per install that every request must prove it holds.
 *
 * T3 shows inline views in a sandboxed frame whose origin is "null", so the page answers null-origin requests for the three reads and the
 * answer an inline view makes (src/web/app.ts). Without a secret, any sandboxed page that can reach the port could read the queue and
 * answer for the operator. The token closes that, and the same token closes the page to anything else that can reach the port:
 *
 *   - 32 random bytes (base64url), made on first start, kept in `secrets/web-token` (mode 0600, src/core/layout.ts);
 *   - every link Chamberlain makes carries it (`?k=<token>`): the inline view's script address, and the page link `chamberlain web link` prints;
 *   - an inline frame sends it as the `x-decision-token` header (a frame holds no cookie we accept);
 *   - a browser that opens a `?k=` link gets a long-lived cookie (`dq_cap`), HMAC-signed with a key derived from the token, so the cookie
 *     carries no token and dies the moment the token is rotated, and the address bar loses the key (a 303 to the same path without it);
 *   - tokens are compared in constant time, and never logged, never written to the events table and never put in an error message;
 *   - `chamberlain web rotate-token` replaces the file: every old link, cookie and already-rendered view stops working at once.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { linkSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { ensureSecretsDir, readSecret, SECRETS_DIR } from "./layout.ts";
import { holdFlock, RelayLockUnavailableError } from "./singleton.ts";

/** The secret's name in `secrets/`. */
export const TOKEN_FILE = "web-token";
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
	/** True when the Cookie header holds a valid, unexpired `dq_cap` cookie signed by the current token. */
	acceptsCookie(cookieHeader: string | null | undefined): boolean;
	/** The Set-Cookie value that gives a browser the capability: signed, carries no token. */
	grant(secure: boolean): string;
};

const cookieKey = (token: string) => createHmac("sha256", token).update("chamberlain-cookie-v1").digest();
const sign = (token: string, exp: number) =>
	createHmac("sha256", cookieKey(token)).update(`${COOKIE_NAME}.v1.${exp}`).digest("hex");

/** A capability over a token that `read` supplies on each call (the file may be rotated under a running page). `now` is the clock. */
export function makeCapability(read: () => string | undefined, now: () => number = Date.now): Capability {
	return {
		accepts(candidate) {
			const token = read();
			if (!token || typeof candidate !== "string" || candidate === "") return false;
			return sameSecret(candidate, token);
		},
		acceptsCookie(header) {
			const token = read();
			if (!token) return false;
			for (const part of (header ?? "").split(";")) {
				const [k, ...v] = part.trim().split("=");
				if (k !== COOKIE_NAME) continue;
				const m = /^v1\.(\d{1,12})\.([0-9a-f]{64})$/.exec(v.join("="));
				if (!m) continue;
				const exp = Number(m[1]);
				if (exp * 1000 <= now()) continue;
				if (sameSecret(m[2]!, sign(token, exp))) return true;
			}
			return false;
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
 * The token, made now if the install has none: published atomically (a complete file, hard-linked into place, so two starting processes get the same one), mode 0600. It NEVER
 * replaces a file that exists: one that stays empty or short (a crash, or written by hand) is an error that says to run `chamberlain web rotate-token`.
 */
export function ensureToken(conf: string, seam: { afterMiss?: () => void } = {}): string {
	const dir = ensureSecretsDir(conf);
	const p = `${dir}/${TOKEN_FILE}`;
	const have = readSecret(conf, TOKEN_FILE);
	if (have) return checked(have);
	seam.afterMiss?.(); // a test seam: where a concurrent process can publish its token, after our read found none
	if (!statSafe(p)) {
		// Published whole or not at all: the token is written to a file of its own and HARD-LINKED to its name, which fails if the name exists. A
		// process that finds the name therefore finds a complete token, and two processes starting together end up with the same one.
		const token = newToken();
		const tmp = `${dir}/${TOKEN_FILE}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
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
	// The file exists, made by another process or left by one that crashed. ensureToken NEVER replaces it (rotating over a winner's file hands the
	// loser a token the disk no longer holds): read it, a few times if it is momentarily empty, and if it stays unusable say so. Only
	// `chamberlain web rotate-token` replaces a token.
	for (let i = 0; i < 20; i++) {
		const t = readSecret(conf, TOKEN_FILE);
		if (t) return checked(t);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
	}
	throw Error(`${SECRETS_DIR}/${TOKEN_FILE} exists but holds no token: run \`chamberlain web rotate-token\``);
}
const checked = (t: string): string => {
	if (t.length < MIN_TOKEN_CHARS)
		throw Error(
			`${SECRETS_DIR}/${TOKEN_FILE} holds fewer than ${MIN_TOKEN_CHARS} characters: run \`chamberlain web rotate-token\``,
		);
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
	let seen: { key: string; token: string | undefined } | undefined;
	const read = (): string | undefined => {
		const p = `${conf}/${SECRETS_DIR}/${TOKEN_FILE}`;
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
				token = readToken(conf);
			} catch {
				token = undefined; // a token file that is not 0600 is not trusted: nothing is accepted until it is fixed
			}
			seen = { key, token };
		}
		return seen.token;
	};
	return makeCapability(read, now);
}

// ---- the links ---------------------------------------------------------------------------------------------

/** The page's address with the key on it: `<base>/?k=<token>`, or another path. Opening it in a browser sets the cookie. */
export const pageLink = (base: string, token: string, path = "/"): string =>
	`${base.replace(/\/+$/, "")}${path}${path.includes("?") ? "&" : "?"}${TOKEN_PARAM}=${encodeURIComponent(token)}`;

/** The script address of the Decisions thread's inline view: `<base>/inline.js?view=decisions[&item=Q-…]&k=<token>`. */
export function inlineScriptSrc(base: string, token: string, item?: string): string {
	const q = [`view=decisions`, ...(item ? [`item=${item}`] : []), `${TOKEN_PARAM}=${encodeURIComponent(token)}`];
	return `${base.replace(/\/+$/, "")}/inline.js?${q.join("&")}`;
}

/** Pure: `s` with every occurrence of `token` replaced, for a message that may have come to hold one. */
export const withoutToken = (s: string, token: string | undefined): string =>
	token ? s.split(token).join("[token]").split(encodeURIComponent(token)).join("[token]") : s;
