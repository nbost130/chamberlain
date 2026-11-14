/** web, continued: see web.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fetchWake } from "../testing/wake.ts";
import { useWebWebFixtures } from "../testing/web-web-fixtures.ts";
import { canonicalIp, checkBind, loadConfig, parseConfig } from "./config.ts";
import { resolveEvidence } from "./evidence.ts";

const { HOST, dirs, item, setup } = useWebWebFixtures(fetchWake);

describe("bind address", () => {
	// Every spelling of the unspecified address, IPv4 and IPv6, including IPv4-mapped forms.
	const UNSPECIFIED = [
		"0.0.0.0",
		"::",
		"[::]",
		"::0",
		"0::",
		"0::0",
		"0:0:0:0:0:0:0:0",
		"0000:0000:0000:0000:0000:0000:0000:0000",
		"0:0:0::0:0",
		"::0:0:0",
		"::0.0.0.0",
		"::ffff:0.0.0.0",
		"::ffff:0:0",
		"::ffff:0000:0000",
		"0:0:0:0:0:ffff:0:0",
		"0000:0000:0000:0000:0000:ffff:0000:0000",
		"0:0:0:0:0:FFFF:0.0.0.0",
		"::FFFF:0:0",
		"[::ffff:0:0]",
		"[0:0:0:0:0:ffff:0:0]",
	];
	// Forms some resolvers read as an address, which an IP literal check must not let through as something else.
	const AMBIGUOUS = [
		"00.0.0.0",
		"0",
		"0x0",
		"0x7f000001",
		"127.1",
		"127.000.000.001",
		"0177.0.0.1",
		"2130706433",
		"127.0.0.1:3790",
		"fe80::1%eth0",
		"::1%lo",
		"1::2::3",
		"12345::1",
		"::ffff:1.2.3",
		"::ffff:256.0.0.1",
	];
	const OUTSIDE = [
		"198.51.100.7",
		"192.168.1.5",
		"10.0.0.1",
		"127.0.0.2",
		"100.63.255.255",
		"100.128.0.1",
		"fe80::1",
		"fd7a:115c:a1e1::1",
		"fd7a:115c:a1df::1",
		"2001:db8::1",
		"::ffff:198.51.100.7",
		"::ffff:192.168.1.5",
		"0:0:0:0:0:ffff:c0a8:105",
		"::2",
	];
	test("refuses every spelling of the unspecified address, and a missing one", () => {
		for (const bad of [undefined, "", "  ", ...UNSPECIFIED]) expect(() => checkBind(bad)).toThrow();
		expect(() => parseConfig({})).toThrow(/no bind address/);
		expect(() => parseConfig({ host: "0.0.0.0", port: 3790 })).toThrow(/not loopback or a Tailscale address/);
		for (const h of UNSPECIFIED) expect(() => parseConfig({ host: h })).toThrow(/not loopback or a Tailscale address/);
	});
	test("refuses ambiguous numeric forms, ports and zone IDs as not an IP literal", () => {
		for (const bad of AMBIGUOUS) expect(() => checkBind(bad)).toThrow(/not an IP/);
	});
	test("refuses every address outside loopback and Tailscale, however it is spelled", () => {
		for (const bad of OUTSIDE) expect(() => checkBind(bad)).toThrow(/not loopback or a Tailscale address/);
	});
	test("refuses a host name, which could resolve to anything", () => {
		for (const bad of ["localhost", "host.tail1234.ts.net", "0", "ip6-localhost"])
			expect(() => checkBind(bad)).toThrow(/not an IP/);
	});
	test("accepts loopback and Tailscale in any spelling, and binds to the canonical form", () => {
		expect(checkBind("100.64.0.7")).toBe("100.64.0.7");
		expect(checkBind("100.64.0.0")).toBe("100.64.0.0");
		expect(checkBind("100.127.255.255")).toBe("100.127.255.255");
		expect(checkBind("::ffff:100.64.0.7")).toBe("100.64.0.7");
		expect(checkBind("::ffff:6440:7")).toBe("100.64.0.7");
		expect(checkBind("127.0.0.1")).toBe("127.0.0.1");
		expect(checkBind("::ffff:127.0.0.1")).toBe("127.0.0.1");
		expect(checkBind("0:0:0:0:0:ffff:7f00:1")).toBe("127.0.0.1");
		expect(checkBind("::1")).toBe("::1");
		expect(checkBind("[::1]")).toBe("::1");
		expect(checkBind("0000:0000:0000:0000:0000:0000:0000:0001")).toBe("::1");
		expect(checkBind("FD7A:115C:A1E0::1234")).toBe("fd7a:115c:a1e0::1234");
		expect(checkBind("fd7a:115c:a1e0:ab12:4843:cd96:6258:b240")).toBe("fd7a:115c:a1e0:ab12:4843:cd96:6258:b240");
		expect(checkBind("fd7a:115c:a1e0:0000:0000:0000:0000:0001")).toBe("fd7a:115c:a1e0::1");
		expect(parseConfig({ host: "100.64.0.7" }).port).toBe(3790);
	});
	test("canonical forms agree with the platform's own parser", async () => {
		const { isIP } = await import("node:net");
		for (const h of [...UNSPECIFIED, ...OUTSIDE].map((x) => x.replace(/^\[|\]$/g, ""))) {
			const c = canonicalIp(h)!;
			expect(c).toBeDefined();
			expect(isIP(c.text)).toBe(c.family);
		}
		for (const h of UNSPECIFIED) expect(canonicalIp(h)!.bytes.every((b) => b === 0)).toBe(true);
	});
	test("refuses a web.json that group or others can read, as afk.ts refuses afk.json", () => {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-cfg-`);
		dirs.push(root);
		writeFileSync(`${root}/web.json`, JSON.stringify({ host: "127.0.0.1", port: 3790 }));
		for (const mode of [0o644, 0o640, 0o604, 0o660]) {
			chmodSync(`${root}/web.json`, mode);
			expect(() => loadConfig(root)).toThrow(/0600/);
		}
		chmodSync(`${root}/web.json`, 0o600);
		expect(loadConfig(root).host).toBe("127.0.0.1");
	});
	test("the server process exits before listening when the address is a wildcard, missing, or web.json is 0644", () => {
		for (const [cfg, mode] of [
			[{ host: "0.0.0.0", port: 3791 }, 0o600],
			[{ host: "::ffff:0000:0000", port: 3791 }, 0o600],
			[{ host: "0:0:0:0:0:ffff:0:0", port: 3791 }, 0o600],
			[{ host: "127.0.0.1", port: 3791 }, 0o644],
			[{ port: 3791 }, 0o600],
			[null, 0],
		] as const) {
			const root = mkdtempSync(`${tmpdir()}/chamberlain-bind-`);
			dirs.push(root);
			if (cfg) {
				writeFileSync(`${root}/web.json`, JSON.stringify(cfg));
				chmodSync(`${root}/web.json`, mode);
			}
			const r = Bun.spawnSync([process.execPath, new URL("./server.ts", import.meta.url).pathname], {
				env: { ...process.env, CHAMBERLAIN_CONF: root, CHAMBERLAIN_STATE: root },
				stdout: "pipe",
				stderr: "pipe",
				timeout: 10_000,
			});
			expect(r.exitCode).toBe(2);
			expect(r.stdout.toString()).not.toContain("decision queue on");
		}
	});
});

describe("evidence", () => {
	function tree() {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-ev-`);
		dirs.push(root);
		const ev = `${root}/evidence`;
		mkdirSync(`${ev}/Q-abcd`, { recursive: true });
		mkdirSync(`${ev}/Q-other`, { recursive: true });
		writeFileSync(`${ev}/Q-abcd/shot.png`, "png");
		writeFileSync(`${ev}/Q-other/x.png`, "png");
		writeFileSync(`${root}/secret.png`, "secret");
		symlinkSync(`${root}/secret.png`, `${ev}/Q-abcd/link.png`);
		symlinkSync(root, `${ev}/Q-link`);
		// resolveEvidence takes the state dir; the tree's root plays it.
		return { root, ev: root };
	}
	test("serves a listed file from the item's own folder", () => {
		const { ev } = tree();
		expect(resolveEvidence(ev, "Q-abcd", "shot.png", ["shot.png"])?.type).toBe("image/png");
	});
	test("refuses everything when the evidence folder itself is a symlink out of the state", async () => {
		const outside = mkdtempSync(`${tmpdir()}/chamberlain-outside-`);
		dirs.push(outside);
		mkdirSync(`${outside}/Q-abcd`);
		writeFileSync(`${outside}/Q-abcd/shot.png`, "secret");
		const s = setup();
		symlinkSync(outside, `${s.state}/evidence`);
		s.add(item("Q-abcd", { evidence: [{ type: "image", path: "shot.png" }] }));
		expect(resolveEvidence(s.state, "Q-abcd", "shot.png", ["shot.png"])).toBeUndefined();
		expect((await s.get("/evidence/Q-abcd/shot.png")).status).toBe(404);
		// Even a symlink that stays inside the state is refused: the folder must be the state's own evidence folder.
		const s2 = setup();
		mkdirSync(`${s2.state}/elsewhere/Q-abcd`, { recursive: true });
		writeFileSync(`${s2.state}/elsewhere/Q-abcd/shot.png`, "png");
		symlinkSync(`${s2.state}/elsewhere`, `${s2.state}/evidence`);
		expect(resolveEvidence(s2.state, "Q-abcd", "shot.png", ["shot.png"])).toBeUndefined();
	});
	test("a state reached through a symlink still serves its own evidence", () => {
		const { root } = tree();
		const link = `${root}-link`;
		symlinkSync(root, link);
		dirs.push(link);
		expect(resolveEvidence(link, "Q-abcd", "shot.png", ["shot.png"])?.type).toBe("image/png");
	});
	test("rejects ../, absolute paths, encoded slashes, unlisted names and symlinks out of the folder", () => {
		const { ev } = tree();
		expect(resolveEvidence(ev, "Q-abcd", "../Q-other/x.png", ["../Q-other/x.png"])).toBeUndefined();
		expect(resolveEvidence(ev, "Q-abcd", "/etc/passwd", ["/etc/passwd"])).toBeUndefined();
		expect(resolveEvidence(ev, "..", "secret.png", ["secret.png"])).toBeUndefined();
		expect(resolveEvidence(ev, "Q-abcd", "x.png", ["shot.png"])).toBeUndefined();
		expect(resolveEvidence(ev, "Q-abcd", "link.png", ["link.png"])).toBeUndefined();
		expect(resolveEvidence(ev, "Q-link", "secret.png", ["secret.png"])).toBeUndefined();
		expect(resolveEvidence(ev, "Q-abcd", "shot.exe", ["shot.exe"])).toBeUndefined();
	});
	test("the route refuses traversal however it is spelled", async () => {
		const s = setup();
		mkdirSync(`${s.state}/evidence/Q-abcd`, { recursive: true });
		writeFileSync(`${s.state}/evidence/Q-abcd/shot.png`, "png");
		writeFileSync(`${s.state}/top.png`, "nope");
		s.add(item("Q-abcd", { evidence: [{ type: "image", path: "shot.png" }] }));
		expect((await s.get("/evidence/Q-abcd/shot.png")).status).toBe(200);
		for (const p of [
			"/evidence/Q-abcd/..%2F..%2Ftop.png",
			"/evidence/Q-abcd/%2e%2e/top.png",
			"/evidence/..%2Ftop.png/x",
			"/evidence/Q-abcd/%2Fetc%2Fpasswd",
			"/evidence/Q-abcd/shot.png/..",
			"/evidence/Q-abcd",
		]) {
			expect((await s.get(p)).status).toBe(404);
		}
	});
});

describe("request guards", () => {
	test("refuses an unknown Host, which is how DNS rebinding arrives", async () => {
		const s = setup();
		expect(
			(await s.app.fetch(new Request("http://evil.example/api/queue", { headers: { host: "evil.example" } }))).status,
		).toBe(421);
	});
	test("refuses a POST without the page's header or from another origin", async () => {
		const s = setup();
		s.add(item("Q-abcd"));
		const form = await s.app.fetch(
			new Request(`http://${HOST}/api/items/Q-abcd/answer`, {
				method: "POST",
				headers: { host: HOST, "content-type": "application/x-www-form-urlencoded" },
				body: "choice=0",
			}),
		);
		expect(form.status).toBe(403);
		expect((await s.post("/api/items/Q-abcd/answer", { choice: 0 }, { origin: "https://evil.example" })).status).toBe(
			403,
		);
		expect((await s.post("/api/items/Q-abcd/answer", { choice: 0 }, { "x-decision-queue": "" })).status).toBe(403);
		await s.app.idle();
		expect(s.posts).toHaveLength(0);
	});
	test("the queue lists open items ranked, with only-you first", async () => {
		const s = setup();
		s.add(item("Q-prod"));
		s.add(item("Q-only", { kind: "only-you", createdAt: "2026-11-09T12:00:00.000Z" }));
		const q = (await (await s.get("/api/queue")).json()) as { items: { id: string; batchable: boolean }[] };
		expect(q.items.map((i) => i.id)).toEqual(["Q-only", "Q-prod"]);
		expect(q.items.map((i) => i.batchable)).toEqual([false, true]);
	});
});
