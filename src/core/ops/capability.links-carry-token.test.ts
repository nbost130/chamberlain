/** capability, continued: see capability.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { useCoreCapabilityFixtures } from "../../testing/core-capability-fixtures.ts";
import { migrateLayout } from "../config/config-migrate.ts";
import { revertLayout } from "../config/config-revert.ts";
import { ensureToken, inlineScriptSrc, pageLink, rotateToken, TOKEN_FILE, withoutToken } from "./capability.ts";

const { conf } = useCoreCapabilityFixtures();

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
