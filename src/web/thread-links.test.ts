/**
 * A card's thread link and the page's `/open/<server>/<threadId>` route (./thread-links.ts): which link each server gets, which
 * config overrides it, and that the route sends a device only to a link it made itself.
 */

import { describe, expect, test } from "bun:test";
import { createFakeAdapter } from "../testing/fake-adapter.ts";
import { useWebThreadLinksFixtures } from "../testing/web-thread-links-fixtures.ts";
import { createLinker, isAppLink, openPage } from "./thread-links.ts";

const { t3, SERVERS, T1, T2, LAUNCHED, LAUNCHED_PATH } = useWebThreadLinksFixtures();

describe("createLinker", () => {
	const linker = createLinker({ servers: () => SERVERS });
	test("each server's link names its own environment", () => {
		expect(linker.link("mithrandir", T1)).toBe(`t3-thread://v2/env-home/${T1}`);
		expect(linker.link("mac", LAUNCHED)).toBe(`t3-thread://v2/env-mac/${LAUNCHED}`);
		expect(linker.link("omar", T2)).toBe(`t3-thread://v2/env-omar/${T2}`);
	});
	test("/open sends a device to the app link, which a phone opens in T3 Code", () => {
		expect(linker.target("mac", T1)).toBe(`t3code://threads/env-mac/${T1}`);
		expect(linker.openPath("mac", LAUNCHED)).toBe(`/open/mac/${LAUNCHED_PATH}`);
	});
	test("a home server whose environment is not known yet has no link and no /open path, never a broken one", () => {
		const l = createLinker({ servers: () => [t3("mithrandir", {})] });
		expect(l.link("mithrandir", T1)).toBeUndefined();
		expect(l.target("mithrandir", T1)).toBeUndefined();
		expect(l.openPath("mithrandir", T1)).toBeUndefined();
	});
	test("an unknown server or an adapter without threadLinks and no prefix gives nothing", () => {
		const thin = { server: { name: "thin", adapter: "fake" }, adapter: createFakeAdapter({ capabilities: [] }) };
		const l = createLinker({ servers: () => [...SERVERS, thin] });
		expect(l.link("nowhere", T1)).toBeUndefined();
		expect(l.openPath("thin", T1)).toBeUndefined();
		expect(l.link("__proto__", T1)).toBeUndefined();
	});
	test("a thread id T3 does not issue gets nothing, not even from a config prefix", () => {
		const l = createLinker({
			servers: () => SERVERS,
			threadLinks: { mac: "https://t3.example/m/" },
			mirrorLinks: { mac: "https://t3.example/m/" },
		});
		for (const bad of [
			"garbage",
			":",
			"a/b",
			"has space",
			"",
			"x\u0000",
			"mcp:launch:NOTHEX",
			`mcp:launch:${"ab".repeat(31)}`,
		]) {
			expect([bad, l.link("mac", bad), l.target("mac", bad), l.openPath("mac", bad)]).toEqual([
				bad,
				undefined,
				undefined,
				undefined,
			]);
		}
	});
	test("a config prefix for a server that is not in `servers` links nothing", () => {
		const l = createLinker({
			servers: () => [],
			threadLinks: { gone: "https://removed.example/t/" },
			mirrorLinks: { gone: "https://removed.example/m/" },
		});
		expect(l.link("gone", LAUNCHED)).toBeUndefined();
		expect(l.target("gone", LAUNCHED)).toBeUndefined();
		expect(l.openPath("gone", LAUNCHED)).toBeUndefined();
	});
	test("web.threadLinks overrides a server's link; an http(s) one is also where /open goes", () => {
		const l = createLinker({ servers: () => SERVERS, threadLinks: { mac: "https://t3.example/env-mac/" } });
		expect(l.link("mac", LAUNCHED)).toBe(`https://t3.example/env-mac/${LAUNCHED_PATH}`);
		expect(l.target("mac", LAUNCHED)).toBe(`https://t3.example/env-mac/${LAUNCHED_PATH}`);
		expect(l.link("omar", T1)).toBe(`t3-thread://v2/env-omar/${T1}`);
	});
	test("a t3-thread:// override is kept as the link, but /open still goes to the app: no browser opens t3-thread://", () => {
		const l = createLinker({
			servers: () => SERVERS,
			threadLinks: { mac: "t3-thread://v2/env-x/" },
			mirrorLinks: { mac: "t3-thread://v2/env-x/" },
		});
		expect(l.link("mac", T1)).toBe(`t3-thread://v2/env-x/${T1}`);
		expect(l.target("mac", T1)).toBe(`t3code://threads/env-mac/${T1}`);
	});
	test("an http(s) web.mirrorLinks prefix is where /open goes for that server", () => {
		const l = createLinker({ servers: () => SERVERS, mirrorLinks: { omar: "https://omar.example/t/" } });
		expect(l.target("omar", T1)).toBe(`https://omar.example/t/${T1}`);
	});
	test("an adapter without threadLinks is linked only by a prefix, for an id made of link-safe characters", () => {
		const thin = { server: { name: "thin", adapter: "fake" }, adapter: createFakeAdapter({ capabilities: [] }) };
		const l = createLinker({ servers: () => [thin], threadLinks: { thin: "https://thin.example/t/" } });
		expect(l.target("thin", "abc-1")).toBe("https://thin.example/t/abc-1");
		expect(l.target("thin", "a/b")).toBeUndefined();
	});
});

describe("the app link a view inside T3's phone app opens directly", () => {
	test("is the adapter's app link when that is where /open goes", () => {
		const l = createLinker({ servers: () => SERVERS });
		expect(l.appLink("mac", LAUNCHED)).toBe(`t3code://threads/env-mac/${LAUNCHED}`);
		expect(l.appLink("mithrandir", T1)).toBe(`t3code://threads/env-home/${T1}`);
	});
	test("is absent when the config sends the thread to an http(s) address, an environment is unknown, or the id is not T3's", () => {
		const l = createLinker({
			servers: () => [...SERVERS, t3("fresh", {})],
			threadLinks: { mac: "https://t3.example/m/" },
		});
		expect(l.appLink("mac", T1)).toBeUndefined();
		expect(l.appLink("fresh", T1)).toBeUndefined();
		expect(l.appLink("omar", "a/b")).toBeUndefined();
		expect(l.appLink("nowhere", T1)).toBeUndefined();
	});
	test("an appScheme a browser would run is never a target or an app link", () => {
		for (const scheme of ["javascript", "data", "vbscript", "file", "http", "https", "blob", "about"]) {
			const l = createLinker({ servers: () => [t3("odd", { environmentId: "env-odd", appScheme: scheme })] });
			expect([scheme, l.appLink("odd", T1), l.target("odd", T1), l.openPath("odd", T1)]).toEqual([
				scheme,
				undefined,
				undefined,
				undefined,
			]);
		}
		const dev = createLinker({ servers: () => [t3("dev", { environmentId: "env-dev", appScheme: "t3code-dev" })] });
		expect(dev.appLink("dev", T1)).toBe(`t3code-dev://threads/env-dev/${T1}`);
	});
	test("isAppLink takes only <scheme>://<link-safe characters> of a scheme no browser runs", () => {
		for (const ok of [
			`t3code://threads/env/${T1}`,
			`t3code://threads/env/${LAUNCHED}`,
			"t3code-preview://threads/e/thread:delegated-task:a%3Ab",
		])
			expect([ok, isAppLink(ok)]).toEqual([ok, true]);
		for (const bad of [
			"javascript://threads/%0aalert(1)",
			"JavaScript://x/y",
			"data://text/html,x",
			"vbscript://x",
			"file:///etc/passwd",
			"https://evil.example/x",
			"http://x/y",
			"t3code:threads/e/t",
			" t3code://threads/e/t",
			't3code://threads/e/t"><img src=x>',
			"t3code://threads/e/t <b>",
			"t3code://threads/e\\t",
			"T3CODE://threads/e/t",
			`t3code://${"a".repeat(1100)}`,
			"",
			undefined,
			42,
		])
			expect([bad, isAppLink(bad)]).toEqual([bad, false]);
	});
});

test("openPage escapes the target and the label", () => {
	const html = openPage('t3code://threads/e/t1"><script>', "<b>x</b>");
	expect(html).toContain('content="0;url=t3code://threads/e/t1&quot;&gt;&lt;script&gt;"');
	expect(html).not.toContain("<script>");
	expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
});

test("openPage goes on by itself and says what to do when nothing opened: a button and a clear line, never a bare link", () => {
	const html = openPage(`t3code://threads/e/${T1}`, "“Build it”");
	expect(html).toContain(`<meta http-equiv="refresh" content="0;url=t3code://threads/e/${T1}">`);
	expect(html).toContain(`<a class="open-go" href="t3code://threads/e/${T1}">Open “Build it”</a>`);
	expect(html).toContain("Nothing opened? Tap the button");
	expect(html).toContain("the app is not installed on this device");
	// The page's CSP allows no inline script or style; its look comes from the page's own stylesheet.
	expect(html).not.toMatch(/<script|style=|<style/);
	expect(html).toContain('<link rel="stylesheet" href="/app.css">');
	expect(openPage("https://t3.example/t/x", "the thread")).not.toContain("not installed");
});
