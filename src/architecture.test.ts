/**
 * The layering rules, enforced by reading every import statement:
 *
 *   - src/core/ never imports from src/adapters/. Core is backend-agnostic; it talks to a backend only through the
 *     Adapter contract (src/core/adapter.ts). Tests in core count: a core test builds its backend with src/testing/.
 *   - An adapter's folder imports only core and itself, never another adapter's folder. Only src/adapters/index.ts
 *     (the registry) names more than one.
 *   - The page's modules (src/web/) work through the contract too. Only its entry point, src/web/server.ts, wires the
 *     registry, and the tests may use an adapter to drive the page against a real backend's shapes.
 *
 * Imports are read from the source with comments removed, type-only imports included: a layering break is a break whether
 * or not the import survives compilation.
 *
 * The same file holds the second rule: there is ONE item system. Tracking a thing, de-duplicating it and re-notifying about it
 * all go through the items table, whose notification columns only `ItemStore.observe` writes, and whose one decision is
 * `decideNotification` (src/core/notification.ts). The tests below fail if a second dedup or re-notification mechanism appears:
 * one of the old identifiers (a sticky or seedable flag, a seen list, a fired file, an in-memory notification clock, or the
 * names the mechanism had before docs/GLOSSARY.md renamed it), another module writing the notification columns, or another
 * module deciding that a notification is due. The scan walks every .ts file under src/ recursively, so a new entry point is scanned the
 * day it is added. A spelling scan finds only what it knows to look for, so the guarantee's real test is behavioural: src/invariants.test.ts
 * (a second process, or a restart, over the same database file). docs/ARCHITECTURE.md says where the guarantee stops.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const SRC = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

/** Pure: the module specifiers of every static import, re-export (type-only ones too) and dynamic import in a source text. */
export function specifiers(code: string): string[] {
	const bare = stripComments(code);
	const out: string[] = [];
	for (const m of bare.matchAll(/\b(?:import|export)\b[^"';]*?\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push((m[1] ?? m[2] ?? m[3])!);
	return out;
}

/** Every .ts file under `dir` of `root`, recursively, as paths relative to `root`. The inventory the scans below run on: nothing is listed by hand. */
export function walk(root: string, dir = ""): string[] {
	return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(root, join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}
/** Every .ts file under a directory of src/, as paths relative to src/. */
const files = (dir: string) => walk(SRC, dir);

/** The relative imports of a source text (static, dynamic and re-exports), resolved against `from` to src/-relative paths. */
export function importsOf(code: string, from: string): string[] {
	return specifiers(code).filter((p) => p.startsWith(".")).map((p) => relative(SRC, resolve(SRC, dirname(from), p)));
}

/** Pure: the violations of the rules in one file: what it imports that it may not. */
export function violations(file: string, code: string): string[] {
	const bad: string[] = [];
	for (const target of importsOf(code, file)) {
		if (file.startsWith("core/") && target.startsWith("adapters")) bad.push(`${file} imports ${target}: core must not import from src/adapters/`);
		const mine = file.match(/^adapters\/([^/]+)\//)?.[1];
		const theirs = target.match(/^adapters\/([^/.]+)(?:\/|\.|$)/)?.[1];
		if (mine && theirs && theirs !== "index" && mine !== theirs) bad.push(`${file} imports ${target}: an adapter must not import another adapter`);
		if (mine && target === "adapters/index.ts") bad.push(`${file} imports the registry: an adapter is made by it, never the reverse`);
		if (file.startsWith("web/") && !file.endsWith(".test.ts") && file !== "web/server.ts" && target.startsWith("adapters")) bad.push(`${file} imports ${target}: the page works through the adapter contract`);
	}
	return bad;
}

describe("the import boundary", () => {
	test("src/core/ has files, so the scan below is not vacuous", () => {
		expect(files("core").length).toBeGreaterThan(20);
		expect(files("adapters").length).toBeGreaterThan(10);
	});

	test("nothing in src/core/ imports from src/adapters/", () => {
		const bad = files("core").flatMap((f) => violations(f, readFileSync(join(SRC, f), "utf8")).filter((v) => v.includes("core must not")));
		expect(bad).toEqual([]);
	});

	test("an adapter imports only core and itself, and the page's modules only the contract", () => {
		const all = [...files("adapters"), ...files("web")];
		const bad = all.flatMap((f) => violations(f, readFileSync(join(SRC, f), "utf8")).filter((v) => !v.includes("core must not")));
		expect(bad).toEqual([]);
	});

	test("the scanner catches each kind of violation (so a pass means something)", () => {
		expect(violations("core/x.ts", 'import { a } from "../adapters/t3/rpc.ts";')).toHaveLength(1);
		expect(violations("core/x.ts", 'export { a } from "../adapters/index.ts";')).toHaveLength(1);
		expect(violations("core/x.ts", 'const m = await import("../adapters/t3/state.ts");')).toHaveLength(1);
		expect(violations("core/x.test.ts", 'import type { T } from "../adapters/fake/index.ts";')).toHaveLength(1);
		expect(violations("core/x.ts", 'import {\n\ta,\n\tb,\n} from "../adapters/t3/state.ts";')).toHaveLength(1);
		expect(violations("core/x.ts", 'import "../adapters/t3/side-effect.ts";')).toHaveLength(1);
		expect(violations("core/x.ts", 'export type * from "../adapters/t3/state.ts";')).toHaveLength(1);
		expect(violations("adapters/t3/x.ts", 'import { a } from "../fake/index.ts";')).toHaveLength(1);
		expect(violations("adapters/t3/x.ts", 'import { a } from "../index.ts";')).toHaveLength(1);
		expect(violations("web/app.ts", 'import { a } from "../adapters/t3/state.ts";')).toHaveLength(1);
		// What is allowed.
		expect(violations("core/x.ts", 'import { a } from "./adapter.ts";\n// import { b } from "../adapters/t3/rpc.ts";\nconst s = \'from "../adapters/x"\';')).toEqual([]);
		expect(violations("adapters/t3/x.ts", 'import { a } from "../../core/adapter.ts";\nimport { b } from "./rpc.ts";')).toEqual([]);
		expect(violations("web/server.ts", 'import { a } from "../adapters/index.ts";')).toEqual([]);
		expect(violations("web/waiting.test.ts", 'import { a } from "../adapters/fake/index.ts";')).toEqual([]);
		expect(violations("adapters/index.ts", 'import { a } from "./t3/index.ts";\nimport { b } from "./fake/index.ts";')).toEqual([]);
	});
});

// ---- one item system --------------------------------------------------------------------------------

/** The identifiers of the mechanisms the item system replaced. Any of them coming back is a second mechanism. */
const OLD_MECHANISMS: [RegExp, string, boolean?][] = [
	[/\bsticky\b/, "a sticky flag (an item's ladder says whether it repeats)"],
	[/\bseedable\b/, "a seedable flag (a finding's baseline says whether it is learned silently)"],
	[/\bSEEN_MAX\b|\bseen\s*:\s*(string\[\]|Set)|\bnextSeen\b|\bdecideSweep\b|\bfindingsFrom\b/, "a seen list (known items are rows in the items table)"],
	[/\balarmedAt\b|\blastAlertedAt\b|\balertedAt\b|\blastNotifiedAt\b|\bnotifiedAt\b/, "an in-memory notification clock (an alarm is an item with a repeat policy)"],
	// The names the mechanism had before the terminology pass (docs/GLOSSARY.md). A copy of old code that brings one back would be a second mechanism.
	[/\bdecideAlert\b|\bwouldAlert\w*|\bLadder\b|\bladder\b|\bstepsMs\b|\balertCount\b|\bnextAlertAt\b|\balert_count\b|\bnext_alert_at\b|\bwould_alert_count\b|\bwould_next_alert_at\b/, "an old name of the notification decision, repeat policy or counters (decideNotification, RepeatPolicy, notification_count)"],
	[/["'`]woken["'`]|["'`]blind["'`]|\bBLIND\b|\bblindText\b/, "an item state or kind of the old model (triggered, acknowledged, resolved; evaluation_error)", true],
	// An in-memory map that de-duplicated card answers, and expired: the one second mechanism the item system's own test once let through.
	[/\bSENT_TTL_MS\b|\bconst\s+sent\s*=\s*new\s+Map\b/, "an in-memory answer-dedup map (a card answer is an item of source card-answer, claimed in the database)"],
	// The one place that may NAME the old state files (and the old woken/ directory) is the importer that reads them (and the config migration's comment about it).
	[/\bfired\.json\b|\bsweep-state\b|\bwoken\//, "a state file for what already fired", true],
];
const LEGACY_READERS = new Set(["core/legacy-import.ts", "cli/import.ts"]);
const NOTIFICATION_COLUMNS = /\b(notification_count|next_notification_at|shadow_notification_count|shadow_next_notification_at)\b/;
const ITEM_WRITE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+items\b/i;
const NOTIFICATION_FIELD_WRITE = /\b(notificationCount|nextNotificationAt|shadowNotificationCount|shadowNextNotificationAt)\s*(\+\+|--|[-+*]?=(?!=))/;
const NOTIFICATION_DUE = /\bnextNotificationAt\s*(<=?|>=?)|(<=?|>=?)\s*[\w.]*\bnextNotificationAt\b/;

/** The files allowed to name the notification columns and to write the items table: the store, its schema, and the one function. */
const ITEM_OWNERS = new Set(["core/sqlite-store.ts", "core/migrations.ts", "core/notification.ts"]);

/** Pure: what a source file does that a second item mechanism would do. `file` is src/-relative. Comments are not code. */
export function itemViolations(file: string, code: string): string[] {
	const bare = stripComments(code);
	const bad: string[] = [];
	for (const [re, what, legacyOk] of OLD_MECHANISMS) if (re.test(bare) && !(legacyOk && LEGACY_READERS.has(file))) bad.push(`${file} has ${what}`);
	if (!ITEM_OWNERS.has(file)) {
		if (NOTIFICATION_COLUMNS.test(bare)) bad.push(`${file} names a notification column: only the store writes them`);
		if (ITEM_WRITE.test(bare)) bad.push(`${file} writes the items table: go through ItemStore.observe`);
		if (NOTIFICATION_FIELD_WRITE.test(bare)) bad.push(`${file} assigns a notification field of an item`);
		if (NOTIFICATION_DUE.test(bare)) bad.push(`${file} decides that a notification is due: that is decideNotification's alone`);
	}
	return bad;
}

describe("one item system", () => {
	// Every non-test source file under src/, found by walking it: a new entry point or folder is scanned the day it is added.
	const sources = () => walk(SRC).filter((f) => !f.endsWith(".test.ts"));

	test("the scan is not vacuous", () => {
		expect(sources().length).toBeGreaterThan(40);
		expect(sources()).toContain("core/sqlite-store.ts");
	});

	test("the inventory is the whole of src/, recursively, with no list to keep up to date", () => {
		const onDisk = [...new Bun.Glob("**/*.ts").scanSync({ cwd: SRC })].filter((f) => !f.endsWith(".test.ts")).sort();
		expect(sources().sort()).toEqual(onDisk);
		// Entry points, nested folders and a folder that does not exist yet are all seen.
		for (const f of ["daemon.ts", "ask.ts", "core/engine.ts", "web/app.ts", "adapters/t3/waiting.ts", "cli/import.ts", "testing/store.ts"]) expect(sources()).toContain(f);
		const root = mkdtempSync(`${tmpdir()}/chamberlain-walk-`);
		try {
			mkdirSync(`${root}/tools/deep`, { recursive: true });
			for (const f of ["new-entry.ts", "tools/a.ts", "tools/deep/b.ts", "tools/deep/b.test.ts", "tools/readme.md"]) writeFileSync(`${root}/${f}`, "");
			expect(walk(root).sort()).toEqual(["new-entry.ts", "tools/a.ts", "tools/deep/b.test.ts", "tools/deep/b.ts"]);
		} finally { rmSync(root, { recursive: true, force: true }); }
	});

	test("no second dedup or re-notification mechanism exists in the source", () => {
		const bad = sources().flatMap((f) => itemViolations(f, readFileSync(join(SRC, f), "utf8")));
		expect(bad).toEqual([]);
	});

	test("only one function decides a notification, and only the store calls it", () => {
		const defs = sources().filter((f) => /export function decideNotification\b/.test(readFileSync(join(SRC, f), "utf8")));
		expect(defs).toEqual(["core/notification.ts"]);
		const callers = sources().filter((f) => /\bdecideNotification\(/.test(readFileSync(join(SRC, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")) && f !== "core/notification.ts");
		expect(callers).toEqual(["core/sqlite-store.ts"]);
	});

	test("nothing in src/core/ but the store opens a database: the core reaches state only through the Store", () => {
		const opens = sources().filter((f) => f.startsWith("core/") && /from\s*["']bun:sqlite["']/.test(readFileSync(join(SRC, f), "utf8")));
		expect(opens).toEqual(["core/sqlite-store.ts"]);
	});

	test("the checker catches each kind of second mechanism (so a pass means something)", () => {
		expect(itemViolations("core/x.ts", "const sticky = true;")).toHaveLength(1);
		expect(itemViolations("core/x.ts", "type F = { seedable?: boolean };")).toHaveLength(1);
		expect(itemViolations("core/x.ts", "const seen: string[] = [];")).toHaveLength(1);
		expect(itemViolations("core/x.ts", "decideSweep(a, b)")).toHaveLength(1);
		expect(itemViolations("core/x.ts", "const alarmedAt = new Map<string, number>();")).toHaveLength(1);
		expect(itemViolations("core/x.ts", "let lastNotifiedAt = 0;")).toHaveLength(1);
		expect(itemViolations("web/x.ts", "const sent = new Map<string, number>();")).toHaveLength(1);
		expect(itemViolations("web/x.ts", "const SENT_TTL_MS = 30 * 60_000;")).toHaveLength(1);
		expect(itemViolations("core/x.ts", "decideAlert(a, b)")).toHaveLength(1);
		expect(itemViolations("core/x.ts", "const ladder = { stepsMs: [1], cap: 2 };")).toHaveLength(1);
		expect(itemViolations("core/x.ts", "SELECT alert_count FROM items")).toHaveLength(1);
		expect(itemViolations("core/x.ts", 'item.status === "woken"')).toHaveLength(1);
		expect(itemViolations("core/x.ts", "const kind = BLIND;")).toHaveLength(1);
		expect(itemViolations("core/x.ts", 'writeFileSync(`${cache}/fired.json`, "[]")')).toHaveLength(1);
		expect(itemViolations("core/x.ts", 'db.run("UPDATE items SET notification_count = 0")')).toHaveLength(2);
		expect(itemViolations("core/x.ts", 'run("INSERT INTO items (source) VALUES (?)")')).toHaveLength(1);
		expect(itemViolations("core/x.ts", "item.notificationCount += 1;")).toHaveLength(1);
		expect(itemViolations("core/x.ts", "if (now >= item.nextNotificationAt) send();")).toHaveLength(1);
		expect(itemViolations("cli/import.ts", 'readFileSync(`${d}/fired.json`)')).toEqual([]);
		expect(itemViolations("core/engine.ts", 'readFileSync(`${d}/fired.json`)')).toHaveLength(1);
		// What is allowed: the owners, comments, tests of a read, and the words in prose.
		expect(itemViolations("core/sqlite-store.ts", 'run("UPDATE items SET notification_count = ?")')).toEqual([]);
		expect(itemViolations("core/notification.ts", "const due = s.nextNotificationAt; if (now >= due) {}")).toEqual([]);
		expect(itemViolations("core/x.ts", "// no sticky flag, no seen list: the items decide\nconst n = item.notificationCount;")).toEqual([]);
		expect(itemViolations("core/x.ts", "const ids = new Set<string>(); const sees = 1;")).toEqual([]);
	});
});

// ---- one relay: the only code that calls a wake transport --------------------------------------------

/**
 * The third rule, and the structure behind "one relay": the relay (src/core/relay.ts) is the ONLY module that calls a wake transport (the
 * adapter's `wake` and `compact`), and it cannot be built without the held one-relay lock (`RelayDeps.lock`, checked at run time against
 * the handles `holdRelayLock` made). The page, `ask.ts` and every command-line tool therefore reach the Steward only by writing outbox rows.
 * A reviewer once found a tool that POSTed to the webhook beside the relay; these scans fail if one comes back. As with the rules above,
 * a scan finds only what it knows to look for: each line below is one way a second sender could appear, and the behavioural test is
 * src/adapters/t3/synthetic-wake.test.ts (a real relay mid-POST and two real tool runs: the webhook never sees two requests at once).
 */
const RELAY = "core/relay.ts";
/** Files that call `.send(` and are not a wake, with the reason. Anything else that calls `.send(` is a violation. */
export const SEND_IS_NOT_A_WAKE: Record<string, string> = {
	"adapters/t3/rpc.ts": "WebSocket frames to the T3 server",
	"web/waiting.ts": "Adapter.send, a message into a worker thread (the answer path), not a wake to the Steward",
	"core/questions.ts": "RecoverOpts.send, a callback the page passes: its direct send to the item's thread, falling back to an outbox row",
	"adapters/t3/index.ts": "the adapter's optional `send` capability (a message into a worker thread), wired from waiting.ts, not the wake transport",
	"core/engine.ts": "Adapter.send, the daemon's one thread ping, used by stalled-thread recovery (src/core/recover.ts) to retry a failed run; not a wake to the Steward",
	"core/adapter.ts": "validateAdapter reads `typeof wake.send` to check the contract is met; it never calls it",
};
/** The only files that may POST over HTTP, with the reason. */
export const MAY_POST: Record<string, string> = {
	"adapters/t3/wake.ts": "the T3 wake transport; only the relay calls it",
	"adapters/t3/rpc.ts": "the websocket ticket request to the T3 server",
	"testing/wake.ts": "fetchWake, a test double for the transport",
};
/** The only files that may name the wake or compaction webhook's config file. */
const NAMES_A_WAKE_URL = new Set(["adapters/t3/index.ts", "adapters/t3/switch-steward.ts", "core/legacy-import.ts"]);
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
const pattern = (names: string) => new RegExp(`\\{[^{}]*\\b(?:${names})\\b[^{}]*\\}(?:\\s*\\})*\\s*(?:=(?![=>])|\\)\\s*(?:=>|\\{)|:\\s*\\w|\\b(?:of|in)\\b)`);
const DESTRUCTURES_SEND = pattern("send");
const DESTRUCTURES_TRANSPORT = pattern("wake|compact");
/**
 * The source with comments removed. A `//` is a comment unless it follows a `:`, a quote or a `/` (the `//` of `https://` or `file:///` inside a
 * string is not one: stripping it would cut the rest of the line, and an import after it would not be seen).
 */
export function stripComments(code: string): string {
	return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\/])\/\/.*$/gm, "$1");
}

/** Pure: what a non-test source file does that only the relay may do. `file` is src/-relative. */
export function senderViolations(file: string, code: string): string[] {
	const bare = stripComments(code);
	const bad: string[] = [];
	const mayNameSend = file === RELAY || file in SEND_IS_NOT_A_WAKE;
	if (!mayNameSend) {
		if (/\.\s*send\b/.test(bare)) bad.push(`${file} calls or takes .send: only core/relay.ts calls a wake transport`);
		if (DESTRUCTURES_SEND.test(bare)) bad.push(`${file} destructures a send out of an object: only core/relay.ts calls a wake transport`);
		if (/\[\s*["'`]send["'`]\s*\]/.test(bare)) bad.push(`${file} reaches a send through a computed property: only core/relay.ts calls a wake transport`);
	}
	if (file !== "core/engine.ts") {
		if (DESTRUCTURES_TRANSPORT.test(bare)) bad.push(`${file} destructures an adapter's wake or compact transport: only the engine hands it to the relay`);
		if (/\[\s*["'`](wake|compact)["'`]\s*\]/.test(bare)) bad.push(`${file} reaches an adapter's wake or compact transport through a computed property: only the engine hands it to the relay`);
	}
	if (/method\s*:\s*["'`]POST["'`]/i.test(bare) && !(file in MAY_POST)) bad.push(`${file} POSTs over HTTP: a wake reaches the Steward only as an outbox row the relay sends`);
	if (/wake-url|compact-url/.test(bare) && !NAMES_A_WAKE_URL.has(file)) bad.push(`${file} names the wake webhook's config file: only the adapter reads it, to hand it to its transport`);
	if (/\b\w*[aA]dapter\??\.(wake|compact)\b/.test(bare) && file !== "core/engine.ts") bad.push(`${file} reaches an adapter's wake transport: only the engine hands it to the relay`);
	for (const [name, where] of Object.entries(MAY_CALL)) if (new RegExp(`\\b${name}\\b`).test(bare) && !where.has(file)) bad.push(`${file} uses ${name}: only ${[...where].join(", ")} may`);
	return bad;
}

/** Where an import specifier points, relative to src/: relative paths are resolved against `file`, absolute ones and file: URLs against the root. */
const resolvedSpecifier = (file: string, spec: string): string => {
	if (spec.startsWith(".")) return relative(SRC, resolve(SRC, dirname(file), spec));
	const abs = spec.replace(/^file:\/\//, "");
	return abs.startsWith("/") ? relative(SRC, abs) : abs;
};
const intoTesting = (resolved: string) => resolved === "testing" || resolved.startsWith("testing/") || /(^|\/)src\/testing(\/|$)/.test(resolved);

/**
 * Pure: a source file that reaches into src/testing/ or names a test-only helper, when it is not itself under src/testing/. Any import,
 * re-export or literal dynamic import that resolves into src/testing/ (relative, absolute, file: URL or a bare path through src/testing) is
 * a violation, and so is a string that names a path under testing/ (a `new URL("../testing/x.ts", import.meta.url)` a spawn would use).
 */
export function testingViolations(file: string, code: string): string[] {
	if (file.startsWith("testing/")) return [];
	const bare = stripComments(code);
	const bad = specifiers(code).filter((spec) => intoTesting(resolvedSpecifier(file, spec))).map((t) => `${file} imports ${t}: production code must not import src/testing/ (testRelay, testRelayLock and the test doubles are for tests)`);
	if (/["'`][^"'`\n]*(?:^|[/\\])testing\/[^"'`\n]*["'`]/.test(bare)) bad.push(`${file} names a path under src/testing/: production code must not reach it, by import or by spawn`);
	// singleton.ts defines holdTestRelayLock (it must sit beside holdRelayLock, and it refuses to run outside a test); nothing else may name it.
	if ((file === "core/singleton.ts" ? /\b(testRelay|testRelayLock)\b/ : /\b(testRelay|testRelayLock|holdTestRelayLock)\b/).test(bare)) bad.push(`${file} names testRelay or testRelayLock: they are test-only`);
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
		if (!/^\s*(["'])[^"'\\\n]*\1\s*[,)]/.test(m[2]!)) bad.push(`${file} has a ${m[1]}(...) whose argument is not a string literal (\`${m[1]}(${m[2]!.slice(0, 50)}\`): production code may only import a name the scan can read`);
	}
	return bad;
}

describe("one relay: the only code that calls a wake transport", () => {
	const sources = () => walk(SRC).filter((f) => !f.endsWith(".test.ts"));

	test("the scan is not vacuous: the relay, the transport and the daemon are all in it", () => {
		for (const f of [RELAY, "adapters/t3/wake.ts", "daemon.ts", "adapters/t3/synthetic-wake.ts", "testing/relay.ts"]) expect(sources()).toContain(f);
	});

	test("no module but the relay calls a wake transport, and no tool or page POSTs", () => {
		expect(sources().flatMap((f) => senderViolations(f, readFileSync(join(SRC, f), "utf8")))).toEqual([]);
	});

	test("the relay really is the sender: it calls the transport, and only after checking the lock", () => {
		const code = stripComments(readFileSync(join(SRC, RELAY), "utf8"));
		expect(code).toMatch(/d\.wake\.send\(/);
		expect(code).toMatch(/d\.compact\.send\(/);
		expect(code).toMatch(/isRelayLock\(d\.lock\)/);
	});

	test("production code never imports src/testing/ (so testRelay and its stubbed lock cannot reach an entry point)", () => {
		expect(sources().flatMap((f) => testingViolations(f, readFileSync(join(SRC, f), "utf8")))).toEqual([]);
	});

	test("production code has no dynamic import or require whose argument is not a string literal", () => {
		expect(sources().flatMap((f) => dynamicImportViolations(f, readFileSync(join(SRC, f), "utf8")))).toEqual([]);
	});

	test("every test-only helper is under src/testing/", () => {
		const defs = sources().filter((f) => /export (async )?function (testRelay|testRelayLock|holdTestRelayLock)\b/.test(readFileSync(join(SRC, f), "utf8")));
		// holdTestRelayLock is the stub-lock handle's maker: it lives beside holdRelayLock, is called only by testing/lock.ts, and refuses to run outside a test.
		expect(defs.sort()).toEqual(["core/singleton.ts", "testing/lock.ts", "testing/relay.ts"]);
	});

	test("a transport destructured out of its object is caught (the reviewer's probe: const {send} = backend.wake; send(...))", () => {
		const probe = "const {send} = backend.wake; await send(id,text);";
		expect(senderViolations("cli/new.ts", probe)).not.toEqual([]);
		expect(senderViolations("cli/new.ts", "const { wake } = backend; const { send } = wake;")).not.toEqual([]);
	});

	test("a computed import of the test helper is caught (the reviewer's probe: import(\"../testing/\" + \"relay.ts\"))", () => {
		const probe = 'const m = await import("../testing/" + "relay.ts"); m["test"+"Relay"](store,wake);';
		expect(testingViolations("cli/new.ts", probe)).not.toEqual([]);
		expect(dynamicImportViolations("cli/new.ts", probe)).not.toEqual([]);
	});

	test("the scanners catch each way a second sender could appear (so a pass means something)", () => {
		// What a tool that POSTs straight to the webhook looks like, in each spelling.
		expect(senderViolations("adapters/t3/x.ts", 'await fetch(url, { method: "POST", body })')).toHaveLength(1);
		expect(senderViolations("web/x.ts", "await fetch(u, { method: 'post' })")).toHaveLength(1);
		expect(senderViolations("adapters/t3/x.ts", 'const url = readFileSync(`${CONF}/wake-url.steward`, "utf8")')).toHaveLength(1);
		expect(senderViolations("adapters/t3/x.ts", 'readFileSync(`${CONF}/compact-url`)')).toHaveLength(1);
		expect(senderViolations("web/x.ts", "await homeAdapter.wake.send(id, text)")).toHaveLength(2);
		expect(senderViolations("core/x.ts", "await compact.send(id, '')")).toHaveLength(1);
		expect(senderViolations("core/x.ts", "const { wake } = adapter; await wake.send(id, m);")).toHaveLength(2);
		expect(senderViolations("core/x.ts", "const t = engine.adapter.compact; t.ready();")).toHaveLength(1);
		expect(senderViolations("cli/x.ts", 'await postWebhook(url, id, text)')).toHaveLength(1);
		expect(senderViolations("cli/x.ts", "const w = webhookWake(() => url);")).toHaveLength(1);
		expect(senderViolations("core/x.ts", "createRelay({ store, wake })")).toHaveLength(1);
		expect(senderViolations("web/x.ts", "createEngine(deps)")).toHaveLength(1);
		expect(senderViolations("cli/x.ts", "holdRelayLock(path)")).toHaveLength(1);
		expect(senderViolations("cli/x.ts", "holdTestRelayLock(path)")).toHaveLength(1);
		// What is allowed.
		expect(senderViolations(RELAY, "await d.wake.send(id, m); await d.compact.send(id, '')")).toEqual([]);
		expect(senderViolations("adapters/t3/wake.ts", 'fetch(url, { method: "POST" }); export const webhookWake = 1; function postWebhook() {}')).toEqual([]);
		expect(senderViolations("adapters/t3/index.ts", 'env.readPrivate("wake-url"); webhookWake(() => u);')).toEqual([]);
		expect(senderViolations("adapters/t3/rpc.ts", 'ws.send(frame); fetch(u, { method: "POST" })')).toEqual([]);
		expect(senderViolations("core/engine.ts", "createRelay({ lock: d.lock, wake: homeAdapter.wake })")).toEqual([]);
		expect(senderViolations("daemon.ts", "const lock = holdRelayLock(p); createEngine({ lock })")).toEqual([]);
		expect(senderViolations("cli/x.ts", '// await fetch(u, { method: "POST" }); wake.send(1)\nconsole.log("wake-url and .send( are words here")')).toHaveLength(2);
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
		expect(senderViolations("core/x.ts", "const { deliveryId, message } = out.wake!; const o = { send: 1 }; const { a, b } = o;")).toEqual([]);
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
		expect(testingViolations("cli/x.ts", 'const w = new URL("../testing/hold-relay.ts", import.meta.url);')).toHaveLength(1);
		// A `file:///` URL in a string is not a comment: the import after it is still read.
		expect(specifiers('const u = "file:///x/y.ts"; import { a } from "./b.ts";')).toEqual(["./b.ts"]);
		expect(stripComments('const u = "https://x.test/a"; // gone\nconst v = 1;')).toBe('const u = "https://x.test/a"; \nconst v = 1;');
		// The reviewer's computed import of the helper: refused as an import into testing/ AND as a dynamic import with a computed argument.
		const smuggled = 'const m = await import("../testing/" + "relay.ts"); m["test" + "Relay"](store, wake);';
		expect(testingViolations("cli/new.ts", smuggled)).toHaveLength(1);
		expect(dynamicImportViolations("cli/new.ts", smuggled)).toHaveLength(1);
		expect(testingViolations("testing/relay.ts", 'import { testRelayLock } from "./lock.ts"; testRelay();')).toEqual([]);
		expect(testingViolations("core/x.ts", "// testRelay is for tests\nimport { a } from './y.ts';")).toEqual([]);
		expect(testingViolations("core/x.ts", 'import { a } from "./testing-notes.ts"; const s = "the testing of x";')).toEqual([]);
		// Dynamic imports: only a plain string literal is allowed in production code.
		expect(dynamicImportViolations("cli/x.ts", "await import(name);")).toHaveLength(1);
		expect(dynamicImportViolations("cli/x.ts", 'await import("../a/" + n + ".ts");')).toHaveLength(1);
		expect(dynamicImportViolations("cli/x.ts", "await import(`../a/${n}.ts`);")).toHaveLength(1);
		expect(dynamicImportViolations("cli/x.ts", "await import(`../a/b.ts`);")).toHaveLength(1);
		expect(dynamicImportViolations("cli/x.ts", "const r = require(path);")).toHaveLength(1);
		expect(dynamicImportViolations("cli/x.ts", 'const m = await Promise.all([import("./a.ts"), import(x)]);')).toHaveLength(1);
		expect(dynamicImportViolations("cli/x.ts", 'await import("./a.ts"); await import("./b.json", { with: { type: "json" } }); const r = require("node:fs");')).toEqual([]);
		expect(dynamicImportViolations("cli/x.ts", "// import(name)\nconst s = import.meta.url; obj.import(x); const reimport = (a) => a; createRequire(import.meta.url);")).toEqual([]);
		expect(dynamicImportViolations("testing/x.ts", "await import(name);")).toEqual([]);
	});
});
