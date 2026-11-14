/** The architecture scanners shared by the architecture.*.test.ts files. A .test.ts, not a file under src/testing/: other scans read every non-test source file for the very patterns these define. No tests here; the architecture.*.test.ts files run them. */

import { dirname, relative, resolve } from "node:path";
import { SRC, specifiers, stripComments } from "./architecture-boundary-scans.test.ts";

/**
 * The third rule, and the structure behind "one relay": the relay (src/core/relay.ts) is the ONLY module that calls a wake transport (the
 * adapter's `wake` and `compact`), and it cannot be built without the held one-relay lock (`RelayDeps.lock`, checked at run time against
 * the handles `holdRelayLock` made). The page, `ask.ts` and every command-line tool therefore reach the Steward only by writing outbox rows.
 * A tool once POSTed to the webhook beside the relay; these scans fail if one comes back. As with the rules above,
 * a scan finds only what it knows to look for: each line below is one way a second sender could appear, and the behavioural test is
 * src/adapters/t3/synthetic-wake.test.ts (a real relay mid-POST and two real tool runs: the webhook never sees two requests at once).
 */
export const RELAY = "core/relay.ts";
/** Files that call `.send(` and are not a wake, with the reason. Anything else that calls `.send(` is a violation. */
const SEND_IS_NOT_A_WAKE: Record<string, string> = {
	"testing/adapters-t3-waiting-fixtures.ts":
		"the rig split out of waiting.test.ts: a fake adapter whose optional `send` capability is passed through, a message into a worker thread, not a wake",
	"testing/web-app-paths-fixtures.ts":
		"the rig split out of app-paths.test.ts: the page's `sendToThread` option, a message into a worker thread, not a wake",
	"testing/web-route-fixtures.ts":
		"the rig split out of route.test.ts: the page's `sendToThread` option, a message into a worker thread, not a wake",
	"adapters/t3/rpc.ts": "WebSocket frames to the T3 server",
	"web/waiting.ts": "Adapter.send, a message into a worker thread (the answer path), not a wake to the Steward",
	"core/questions-claim.ts":
		"RecoverOpts.send, a callback the page passes: its direct send to the item's thread, falling back to an outbox row",
	"adapters/t3/index.ts":
		"the adapter's optional `send` capability (a message into a worker thread), wired from waiting.ts, not the wake transport",
	"core/engine.ts":
		"Adapter.send, the daemon's one thread ping, used by stalled-thread recovery (src/core/recover.ts) to retry a failed run; not a wake to the Steward",
	"core/adapter-conformance.ts":
		"validateAdapter reads `typeof wake.send` to check the contract is met; it never calls it",
	"core/classifier/config.ts":
		"the idle-thread classifier's `send` settings (how much text a provider gets), a config section, not a transport",
	"core/classifier/classify.ts": "reads the classifier config's `send` settings; it never sends a wake",
	"core/classifier/classify-one.ts": "reads the classifier config's `send` settings; it never sends a wake",
};
/** The only files that may POST over HTTP, with the reason. */
const MAY_POST: Record<string, string> = {
	"testing/web-confirmation-fixtures.ts":
		"the page's test rig, split out of confirmation.test.ts: it POSTs to the page under test as an in-process request, never a wake",
	"testing/web-capability-fixtures.ts":
		"the page's test rig, split out of capability.test.ts: it POSTs to the page under test as an in-process request, never a wake",
	"testing/web-web-fixtures.ts":
		"the page's test rig, split out of web.test.ts: it POSTs to the page under test as an in-process request, never a wake",
	"testing/web-route-fixtures.ts":
		"the page's test rig, split out of route.test.ts: it POSTs to the page under test as an in-process request, never a wake",
	"adapters/t3/wake.ts": "the T3 wake transport; only the relay calls it",
	"adapters/t3/rpc.ts": "the websocket ticket request to the T3 server",
	"testing/wake.ts": "fetchWake, a test double for the transport",
	"core/classifier/providers.ts":
		"the opt-in idle-thread classifier's one Jev request per thread (a classification, never a wake to the Steward)",
};
/** The only files that may name the wake or compaction webhook's config file. */
const NAMES_A_WAKE_URL = new Set([
	"adapters/t3/index.ts",
	"adapters/t3/switch-steward.ts",
	// A fixture of the old config directory: it names every file of it, to prove the migration moves each one (it sends nothing).
	"testing/legacy-conf.ts",
	// The crash tests' rig (split out of crash.test.ts): it writes the real daemon's wake-url file, pointing at its own local webhook, so the daemon under test has somewhere to send (it sends nothing itself).
	"testing/crash-fixtures.ts",
]);
/** Where each construct that can send or enable sending may appear (a definition site and its legitimate callers). */
const MAY_CALL: Record<string, Set<string>> = {
	createRelay: new Set([RELAY, "core/engine.ts", "testing/relay.ts"]),
	createEngine: new Set(["core/engine.ts", "daemon.ts"]),
	holdRelayLock: new Set(["core/singleton.ts", "daemon.ts", "testing/hold-relay.ts", "testing/lock.ts"]),
	holdTestRelayLock: new Set(["core/singleton.ts", "testing/lock.ts"]),
	postWebhook: new Set(["adapters/t3/wake.ts"]),
	webhookWake: new Set(["adapters/t3/wake.ts", "adapters/t3/index.ts"]),
	fetchWake: new Set(["testing/wake.ts"]),
};
/**
 * A destructuring pattern that takes `send` (or an adapter's `wake` or `compact`) out of an object, in an assignment (`const { send } = t`, also
 * renamed and nested: `{ wake: { send: s } } = a`), a parameter (`({ send }) =>`) or a loop (`for (const { send } of ts)`).
 */
const pattern = (names: string) =>
	new RegExp(
		`\\{[^{}]*\\b(?:${names})\\b[^{}]*\\}(?:\\s*\\})*\\s*(?:=(?![=>])|\\)\\s*(?:=>|\\{)|:\\s*\\w|\\b(?:of|in)\\b)`,
	);
const DESTRUCTURES_SEND = pattern("send");
const DESTRUCTURES_TRANSPORT = pattern("wake|compact");

/** Pure: what a non-test source file does that only the relay may do. `file` is src/-relative. */
export function senderViolations(file: string, code: string): string[] {
	const bare = stripComments(code);
	const bad: string[] = [];
	const mayNameSend = file === RELAY || file in SEND_IS_NOT_A_WAKE;
	if (!mayNameSend) {
		if (/\.\s*send\b/.test(bare)) bad.push(`${file} calls or takes .send: only core/relay.ts calls a wake transport`);
		if (DESTRUCTURES_SEND.test(bare))
			bad.push(`${file} destructures a send out of an object: only core/relay.ts calls a wake transport`);
		if (/\[\s*["'`]send["'`]\s*\]/.test(bare))
			bad.push(`${file} reaches a send through a computed property: only core/relay.ts calls a wake transport`);
	}
	if (file !== "core/engine.ts") {
		if (DESTRUCTURES_TRANSPORT.test(bare))
			bad.push(`${file} destructures an adapter's wake or compact transport: only the engine hands it to the relay`);
		if (/\[\s*["'`](wake|compact)["'`]\s*\]/.test(bare))
			bad.push(
				`${file} reaches an adapter's wake or compact transport through a computed property: only the engine hands it to the relay`,
			);
	}
	if (/method\s*:\s*["'`]POST["'`]/i.test(bare) && !(file in MAY_POST))
		bad.push(`${file} POSTs over HTTP: a wake reaches the Steward only as an outbox row the relay sends`);
	if (/wake-url|compact-url/.test(bare) && !NAMES_A_WAKE_URL.has(file))
		bad.push(`${file} names the wake webhook's config file: only the adapter reads it, to hand it to its transport`);
	if (/\b\w*[aA]dapter\??\.(wake|compact)\b/.test(bare) && file !== "core/engine.ts")
		bad.push(`${file} reaches an adapter's wake transport: only the engine hands it to the relay`);
	for (const [name, where] of Object.entries(MAY_CALL))
		if (new RegExp(`\\b${name}\\b`).test(bare) && !where.has(file))
			bad.push(`${file} uses ${name}: only ${[...where].join(", ")} may`);
	return bad;
}

/** Where an import specifier points, relative to src/: relative paths are resolved against `file`, absolute ones and file: URLs against the root. */
const resolvedSpecifier = (file: string, spec: string): string => {
	if (spec.startsWith(".")) return relative(SRC, resolve(SRC, dirname(file), spec));
	const abs = spec.replace(/^file:\/\//, "");
	return abs.startsWith("/") ? relative(SRC, abs) : abs;
};
const intoTesting = (resolved: string) =>
	resolved === "testing" || resolved.startsWith("testing/") || /(^|\/)src\/testing(\/|$)/.test(resolved);

/**
 * Pure: a source file that reaches into src/testing/ or names a test-only helper, when it is not itself under src/testing/. Any import,
 * re-export or literal dynamic import that resolves into src/testing/ (relative, absolute, file: URL or a bare path through src/testing) is
 * a violation, and so is a string that names a path under testing/ (a `new URL("../testing/x.ts", import.meta.url)` a spawn would use).
 */
export function testingViolations(file: string, code: string): string[] {
	if (file.startsWith("testing/")) return [];
	const bare = stripComments(code);
	const bad = specifiers(code)
		.filter((spec) => intoTesting(resolvedSpecifier(file, spec)))
		.map(
			(t) =>
				`${file} imports ${t}: production code must not import src/testing/ (testRelay, testRelayLock and the test doubles are for tests)`,
		);
	if (/["'`][^"'`\n]*(?:^|[/\\])testing\/[^"'`\n]*["'`]/.test(bare))
		bad.push(`${file} names a path under src/testing/: production code must not reach it, by import or by spawn`);
	// singleton.ts defines holdTestRelayLock (it must sit beside holdRelayLock, and it refuses to run outside a test); nothing else may name it.
	if (
		(file === "core/singleton.ts"
			? /\b(testRelay|testRelayLock)\b/
			: /\b(testRelay|testRelayLock|holdTestRelayLock)\b/
		).test(bare)
	)
		bad.push(`${file} names testRelay or testRelayLock: they are test-only`);
	return bad;
}

/**
 * Pure: a dynamic `import(...)` or `require(...)` in production code (not src/testing/) whose argument is not one plain string literal. A
 * computed specifier (`import("../testing/" + "relay.ts")`) cannot be read by the import scan, so it is not allowed at all.
 */
export function dynamicImportViolations(file: string, code: string): string[] {
	if (file.startsWith("testing/")) return [];
	const bad: string[] = [];
	for (const m of stripComments(code).matchAll(/(?<![\w$.])(import|require)\s*\((?=([^\n]{0,80}))/g)) {
		if (!/^\s*(["'])[^"'\\\n]*\1\s*[,)]/.test(m[2]!))
			bad.push(
				`${file} has a ${m[1]}(...) whose argument is not a string literal (\`${m[1]}(${m[2]!.slice(0, 50)}\`): production code may only import a name the scan can read`,
			);
	}
	return bad;
}
