/** architecture, continued: the one-relay rules. See architecture.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SRC, specifiers, stripComments, walk } from "./architecture-boundary-scans.test.ts";
import {
	dynamicImportViolations,
	RELAY,
	senderViolations,
	testingViolations,
} from "./architecture-relay-scans.test.ts";

describe("one relay: the only code that calls a wake transport", () => {
	const sources = () => walk(SRC).filter((f) => !f.endsWith(".test.ts"));

	test("the scan is not vacuous: the relay, the transport and the daemon are all in it", () => {
		for (const f of [RELAY, "adapters/t3/wake.ts", "daemon.ts", "adapters/t3/synthetic-wake.ts", "testing/relay.ts"])
			expect(sources()).toContain(f);
	});

	test("no module but the relay calls a wake transport, and no tool or page POSTs", () => {
		expect(sources().flatMap((f) => senderViolations(f, readFileSync(join(SRC, f), "utf8")))).toEqual([]);
	});

	test("the relay really is the sender: it calls the transport, and only after checking the lock", () => {
		const code = stripComments(readFileSync(join(SRC, RELAY), "utf8"));
		expect(code).toMatch(/\bl\.wake\.send\(/);
		expect(code).toMatch(/d\.compact\.send\(/);
		expect(code).toMatch(/isRelayLock\(d\.lock\)/);
	});

	test("production code builds ONE relay: one createRelay call, in the engine, and one createEngine call, in the daemon", () => {
		const calls = (name: string) =>
			sources().flatMap((f) =>
				(stripComments(readFileSync(join(SRC, f), "utf8")).match(new RegExp(`\\b${name}\\(`, "g")) ?? []).map(() => f),
			);
		// The definitions are `function createRelay(` / `function createEngine(`; every other match is a call.
		expect(calls("createRelay").sort()).toEqual([RELAY, "core/engine.ts", "testing/relay.ts"].sort());
		expect(calls("createEngine").sort()).toEqual(["core/engine.ts", "daemon.ts"]);
		// Every receiver (the Steward, the Alert Desk) is a lane of that relay, never a relay of its own.
		expect(stripComments(readFileSync(join(SRC, "core/engine.ts"), "utf8"))).toMatch(
			/receivers:\s*\{\s*\[DESK_RECEIVER\]/,
		);
	});

	test("one relay per process and per store, at run time: a second relay or engine on the held lock is refused, and so is a second lock", async () => {
		const { holdRelayLock, RelayRunningError } = await import("./core/singleton.ts");
		const { openStore } = await import("./core/sqlite-store.ts");
		const { createRelay } = await import("./core/relay.ts");
		const { createEngine } = await import("./core/engine.ts");
		const { createFakeAdapter } = await import("./testing/fake-adapter.ts");
		const root = mkdtempSync(join(tmpdir(), "chamberlain-one-relay-"));
		const db = join(root, "chamberlain.db");
		const lock = holdRelayLock(db);
		const store = openStore(db);
		try {
			const wake = { ready: () => true, send: async () => ({ ok: true }) };
			const base = { store, lock, wake, gate: () => "idle" as const, log: () => {}, alarm: () => {} };
			expect(() => createRelay(base)).not.toThrow();
			expect(() => createRelay({ ...base, receivers: { desk: { wake, gate: () => "idle" as const } } })).toThrow(
				"a relay already exists on this lock",
			);
			expect(() =>
				createEngine({
					conf: root,
					lock,
					store,
					servers: [{ server: { name: "fake", adapter: "fake" }, adapter: createFakeAdapter() }],
					log: () => {},
				}),
			).toThrow("a relay already exists on this lock");
			expect(() => holdRelayLock(db)).toThrow(RelayRunningError);
		} finally {
			store.close();
			lock.release();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("production code never imports src/testing/ (so testRelay and its stubbed lock cannot reach an entry point)", () => {
		expect(sources().flatMap((f) => testingViolations(f, readFileSync(join(SRC, f), "utf8")))).toEqual([]);
	});

	test("production code has no dynamic import or require whose argument is not a string literal", () => {
		expect(sources().flatMap((f) => dynamicImportViolations(f, readFileSync(join(SRC, f), "utf8")))).toEqual([]);
	});

	test("every test-only helper is under src/testing/", () => {
		const defs = sources().filter((f) =>
			/export (async )?function (testRelay|testRelayLock|holdTestRelayLock)\b/.test(readFileSync(join(SRC, f), "utf8")),
		);
		// holdTestRelayLock is the stub-lock handle's maker: it lives beside holdRelayLock, is called only by testing/lock.ts, and refuses to run outside a test.
		expect(defs.sort()).toEqual(["core/singleton.ts", "testing/lock.ts", "testing/relay.ts"]);
	});

	test("a transport destructured out of its object is caught (const {send} = backend.wake; send(...))", () => {
		const probe = "const {send} = backend.wake; await send(id,text);";
		expect(senderViolations("cli/new.ts", probe)).not.toEqual([]);
		expect(senderViolations("cli/new.ts", "const { wake } = backend; const { send } = wake;")).not.toEqual([]);
	});

	test('a computed import of the test helper is caught (import("../testing/" + "relay.ts"))', () => {
		const probe = 'const m = await import("../testing/" + "relay.ts"); m["test"+"Relay"](store,wake);';
		expect(testingViolations("cli/new.ts", probe)).not.toEqual([]);
		expect(dynamicImportViolations("cli/new.ts", probe)).not.toEqual([]);
	});

	test("the scanners catch each way a second sender could appear (so a pass means something)", () => {
		// What a tool that POSTs straight to the webhook looks like, in each spelling.
		expect(senderViolations("adapters/t3/x.ts", 'await fetch(url, { method: "POST", body })')).toHaveLength(1);
		expect(senderViolations("web/x.ts", "await fetch(u, { method: 'post' })")).toHaveLength(1);
		expect(
			senderViolations("adapters/t3/x.ts", `const url = readFileSync(\`\${CONF}/wake-url.steward\`, "utf8")`),
		).toHaveLength(1);
		expect(senderViolations("adapters/t3/x.ts", `readFileSync(\`\${CONF}/compact-url\`)`)).toHaveLength(1);
		expect(senderViolations("web/x.ts", "await homeAdapter.wake.send(id, text)")).toHaveLength(2);
		expect(senderViolations("core/x.ts", "await compact.send(id, '')")).toHaveLength(1);
		expect(senderViolations("core/x.ts", "const { wake } = adapter; await wake.send(id, m);")).toHaveLength(2);
		expect(senderViolations("core/x.ts", "const t = engine.adapter.compact; t.ready();")).toHaveLength(1);
		expect(senderViolations("cli/x.ts", "await postWebhook(url, id, text)")).toHaveLength(1);
		expect(senderViolations("cli/x.ts", "const w = webhookWake(() => url);")).toHaveLength(1);
		expect(senderViolations("core/x.ts", "createRelay({ store, wake })")).toHaveLength(1);
		expect(senderViolations("web/x.ts", "createEngine(deps)")).toHaveLength(1);
		expect(senderViolations("cli/x.ts", "holdRelayLock(path)")).toHaveLength(1);
		expect(senderViolations("cli/x.ts", "holdTestRelayLock(path)")).toHaveLength(1);
		// What is allowed.
		expect(senderViolations(RELAY, "await d.wake.send(id, m); await d.compact.send(id, '')")).toEqual([]);
		expect(
			senderViolations(
				"adapters/t3/wake.ts",
				'fetch(url, { method: "POST" }); export const webhookWake = 1; function postWebhook() {}',
			),
		).toEqual([]);
		expect(senderViolations("adapters/t3/index.ts", 'env.readPrivate("wake-url"); webhookWake(() => u);')).toEqual([]);
		expect(senderViolations("adapters/t3/rpc.ts", 'ws.send(frame); fetch(u, { method: "POST" })')).toEqual([]);
		expect(senderViolations("core/engine.ts", "createRelay({ lock: d.lock, wake: homeAdapter.wake })")).toEqual([]);
		expect(senderViolations("daemon.ts", "const lock = holdRelayLock(p); createEngine({ lock })")).toEqual([]);
		expect(
			senderViolations(
				"cli/x.ts",
				'// await fetch(u, { method: "POST" }); wake.send(1)\nconsole.log("wake-url and .send( are words here")',
			),
		).toHaveLength(2);
		expect(senderViolations("cli/x.ts", "// a comment about wake-url and .send(")).toEqual([]);
		// A transport taken out of its object or aliased: each is a way to call it without writing `.send(`.
		expect(senderViolations("cli/new.ts", "const {send} = backend.wake; await send(id, text);")).toHaveLength(1);
		expect(senderViolations("cli/new.ts", "const { wake: { send: s } } = backend; await s(id, text);")).toHaveLength(1);
		expect(senderViolations("cli/new.ts", "const send = backend.wake.send; await send(id, text);")).toHaveLength(1);
		expect(senderViolations("cli/new.ts", "const send = adapter.wake.send.bind(adapter.wake);")).toHaveLength(2);
		expect(senderViolations("cli/new.ts", 'const t = backend["wake"]; await t["send"](id, text);')).toHaveLength(2);
		expect(senderViolations("cli/new.ts", "function f({ send }) { return send(1, 2); }")).toHaveLength(1);
		expect(senderViolations("cli/new.ts", "for (const { send } of transports) await send(id, m);")).toHaveLength(1);
		expect(senderViolations("cli/new.ts", "const { compact } = engine.adapter;")).toHaveLength(1);
		expect(senderViolations("cli/new.ts", "const { wake: w, compact: c } = homeAdapter;")).toHaveLength(1);
		// ...and what is not one.
		expect(
			senderViolations(
				"core/x.ts",
				"const { deliveryId, message } = out.wake!; const o = { send: 1 }; const { a, b } = o;",
			),
		).toEqual([]);
		expect(senderViolations("core/engine.ts", "const { wake, compact } = homeAdapter;")).toEqual([]);
		expect(senderViolations(RELAY, "const t = d.wake; await t.send(id, m);")).toEqual([]);
		// The test-only boundary: a static, literal or computed way in.
		expect(testingViolations("daemon.ts", 'import { testRelay } from "./testing/relay.ts";')).toHaveLength(3);
		expect(testingViolations("web/server.ts", 'import { memStore } from "../testing/store.ts";')).toHaveLength(2);
		expect(testingViolations("core/x.ts", 'const m = await import("../testing/lock.ts");')).toHaveLength(2);
		expect(testingViolations("adapters/t3/x.ts", "export const a = testRelayLock();")).toHaveLength(1);
		expect(testingViolations("adapters/t3/x.ts", "export const a = holdTestRelayLock('x');")).toHaveLength(1);
		expect(testingViolations("core/singleton.ts", "export function holdTestRelayLock() {}")).toEqual([]);
		expect(testingViolations("cli/x.ts", 'import { a } from "/srv/app/src/testing/relay.ts";')).toHaveLength(2);
		expect(testingViolations("cli/x.ts", 'import { a } from "file:///srv/app/src/testing/relay.ts";')).toHaveLength(2);
		expect(testingViolations("cli/x.ts", 'import { a } from "src/testing/relay.ts";')).toHaveLength(2);
		expect(
			testingViolations("cli/x.ts", 'const w = new URL("../testing/hold-relay.ts", import.meta.url);'),
		).toHaveLength(1);
		// A `file:///` URL in a string is not a comment: the import after it is still read.
		expect(specifiers('const u = "file:///x/y.ts"; import { a } from "./b.ts";')).toEqual(["./b.ts"]);
		expect(stripComments('const u = "https://x.test/a"; // gone\nconst v = 1;')).toBe(
			'const u = "https://x.test/a"; \nconst v = 1;',
		);
		// A computed import of the helper: refused as an import into testing/ AND as a dynamic import with a computed argument.
		const smuggled = 'const m = await import("../testing/" + "relay.ts"); m["test" + "Relay"](store, wake);';
		expect(testingViolations("cli/new.ts", smuggled)).toHaveLength(1);
		expect(dynamicImportViolations("cli/new.ts", smuggled)).toHaveLength(1);
		expect(testingViolations("testing/relay.ts", 'import { testRelayLock } from "./lock.ts"; testRelay();')).toEqual(
			[],
		);
		expect(testingViolations("core/x.ts", "// testRelay is for tests\nimport { a } from './y.ts';")).toEqual([]);
		expect(
			testingViolations("core/x.ts", 'import { a } from "./testing-notes.ts"; const s = "the testing of x";'),
		).toEqual([]);
		// Dynamic imports: only a plain string literal is allowed in production code.
		expect(dynamicImportViolations("cli/x.ts", "await import(name);")).toHaveLength(1);
		expect(dynamicImportViolations("cli/x.ts", 'await import("../a/" + n + ".ts");')).toHaveLength(1);
		expect(dynamicImportViolations("cli/x.ts", `await import(\`../a/\${n}.ts\`);`)).toHaveLength(1);
		expect(dynamicImportViolations("cli/x.ts", "await import(`../a/b.ts`);")).toHaveLength(1);
		expect(dynamicImportViolations("cli/x.ts", "const r = require(path);")).toHaveLength(1);
		expect(
			dynamicImportViolations("cli/x.ts", 'const m = await Promise.all([import("./a.ts"), import(x)]);'),
		).toHaveLength(1);
		expect(
			dynamicImportViolations(
				"cli/x.ts",
				'await import("./a.ts"); await import("./b.json", { with: { type: "json" } }); const r = require("node:fs");',
			),
		).toEqual([]);
		expect(
			dynamicImportViolations(
				"cli/x.ts",
				"// import(name)\nconst s = import.meta.url; obj.import(x); const reimport = (a) => a; createRequire(import.meta.url);",
			),
		).toEqual([]);
		expect(dynamicImportViolations("testing/x.ts", "await import(name);")).toEqual([]);
	});
});
