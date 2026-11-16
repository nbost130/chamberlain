/** architecture, continued: the one-item-system rules. See architecture.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SRC, stripComments, walk } from "./architecture-boundary-scans.test.ts";

/** The identifiers of the mechanisms the item system replaced. Any of them coming back is a second mechanism. */
const OLD_MECHANISMS: [RegExp, string][] = [
	[/\bsticky\b/, "a sticky flag (an item's ladder says whether it repeats)"],
	[/\bseedable\b/, "a seedable flag (a finding's baseline says whether it is learned silently)"],
	[
		/\bSEEN_MAX\b|\bseen\s*:\s*(string\[\]|Set)|\bnextSeen\b|\bdecideSweep\b|\bfindingsFrom\b/,
		"a seen list (known items are rows in the items table)",
	],
	[
		/\balarmedAt\b|\blastAlertedAt\b|\balertedAt\b|\blastNotifiedAt\b|\bnotifiedAt\b/,
		"an in-memory notification clock (an alarm is an item with a repeat policy)",
	],
	// The names the mechanism had before the terminology pass (docs/GLOSSARY.md). A copy of old code that brings one back would be a second mechanism.
	[
		/\bdecideAlert\b|\bwouldAlert\w*|\bLadder\b|\bladder\b|\bstepsMs\b|\balertCount\b|\bnextAlertAt\b|\balert_count\b|\bnext_alert_at\b|\bwould_alert_count\b|\bwould_next_alert_at\b/,
		"an old name of the notification decision, repeat policy or counters (decideNotification, RepeatPolicy, notification_count)",
	],
	[
		/["'`]woken["'`]|["'`]blind["'`]|\bBLIND\b|\bblindText\b/,
		"an item state or kind of the old model (triggered, acknowledged, resolved; evaluation_error)",
	],
	// An in-memory map that de-duplicated card answers, and expired: the one second mechanism the item system's own test once let through.
	[
		/\bSENT_TTL_MS\b|\bconst\s+sent\s*=\s*new\s+Map\b/,
		"an in-memory answer-dedup map (a card answer is an item of source card-answer, claimed in the database)",
	],
	// Nothing may name the old state files (or the old woken/ directory): state lives in the database.
	[/\bfired\.json\b|\bsweep-state\b|\bwoken\//, "a state file for what already fired"],
];
const NOTIFICATION_COLUMNS =
	/\b(notification_count|next_notification_at|shadow_notification_count|shadow_next_notification_at)\b/;
const ITEM_WRITE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+items\b/i;
const NOTIFICATION_FIELD_WRITE =
	/\b(notificationCount|nextNotificationAt|shadowNotificationCount|shadowNextNotificationAt)\s*(\+\+|--|[-+*]?=(?!=))/;
const NOTIFICATION_DUE = /\bnextNotificationAt\s*(<=?|>=?)|(<=?|>=?)\s*[\w.]*\bnextNotificationAt\b/;

/** The files allowed to name the notification columns and to write the items table: the store's items module, its schema, and the one function. */
const ITEM_OWNERS = new Set(["core/store/sqlite-items.ts", "core/store/migrations.ts", "core/items/notification.ts"]);

/** Pure: what a source file does that a second item mechanism would do. `file` is src/-relative. Comments are not code. */
export function itemViolations(file: string, code: string): string[] {
	const bare = stripComments(code);
	const bad: string[] = [];
	for (const [re, what] of OLD_MECHANISMS) if (re.test(bare)) bad.push(`${file} has ${what}`);
	if (!ITEM_OWNERS.has(file)) {
		if (NOTIFICATION_COLUMNS.test(bare)) bad.push(`${file} names a notification column: only the store writes them`);
		if (ITEM_WRITE.test(bare)) bad.push(`${file} writes the items table: go through ItemStore.observe`);
		if (NOTIFICATION_FIELD_WRITE.test(bare)) bad.push(`${file} assigns a notification field of an item`);
		if (NOTIFICATION_DUE.test(bare))
			bad.push(`${file} decides that a notification is due: that is decideNotification's alone`);
	}
	return bad;
}

describe("one item system", () => {
	// Every non-test source file under src/, found by walking it: a new entry point or folder is scanned the day it is added.
	const sources = () => walk(SRC).filter((f) => !f.endsWith(".test.ts"));

	test("the scan is not vacuous", () => {
		expect(sources().length).toBeGreaterThan(40);
		expect(sources()).toContain("core/store/sqlite-store.ts");
	});

	test("the inventory is the whole of src/, recursively, with no list to keep up to date", () => {
		const onDisk = [...new Bun.Glob("**/*.ts").scanSync({ cwd: SRC })].filter((f) => !f.endsWith(".test.ts")).sort();
		expect(sources().sort()).toEqual(onDisk);
		// Entry points, nested folders and a folder that does not exist yet are all seen.
		for (const f of [
			"daemon.ts",
			"ask.ts",
			"core/engine/engine.ts",
			"web/app.ts",
			"adapters/t3/waiting.ts",
			"cli.ts",
			"testing/store.ts",
		])
			expect(sources()).toContain(f);
		const root = mkdtempSync(`${tmpdir()}/chamberlain-walk-`);
		try {
			mkdirSync(`${root}/tools/deep`, { recursive: true });
			for (const f of ["new-entry.ts", "tools/a.ts", "tools/deep/b.ts", "tools/deep/b.test.ts", "tools/readme.md"])
				writeFileSync(`${root}/${f}`, "");
			expect(walk(root).sort()).toEqual(["new-entry.ts", "tools/a.ts", "tools/deep/b.test.ts", "tools/deep/b.ts"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("no second dedup or re-notification mechanism exists in the source", () => {
		const bad = sources().flatMap((f) => itemViolations(f, readFileSync(join(SRC, f), "utf8")));
		expect(bad).toEqual([]);
	});

	test("only one function decides a notification, and only the store calls it", () => {
		const defs = sources().filter((f) =>
			/export function decideNotification\b/.test(readFileSync(join(SRC, f), "utf8")),
		);
		expect(defs).toEqual(["core/items/notification.ts"]);
		const callers = sources().filter(
			(f) =>
				/\bdecideNotification\(/.test(readFileSync(join(SRC, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")) &&
				f !== "core/items/notification.ts",
		);
		expect(callers).toEqual(["core/store/sqlite-items.ts"]);
	});

	test("nothing in src/core/ but the store, the shared opener and the telemetry opener opens a database: the core reaches state only through the Store", () => {
		// The ledger database is opened through the shared opener (src/core/store/database.ts, which an optional module's own database file uses too) and
		// the Store's own read-only fold (sqlite-store.ts). The telemetry database (`obs.db`), and the read-only open of the ledger that the
		// reconciler needs, are the one other place: core/obs/db.ts, which everything else in core/obs/ goes through.
		const opens = sources().filter(
			(f) => f.startsWith("core/") && /from\s*["']bun:sqlite["']/.test(readFileSync(join(SRC, f), "utf8")),
		);
		expect(opens.sort()).toEqual(["core/obs/db.ts", "core/store/database.ts", "core/store/sqlite-store.ts"]);
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
		expect(itemViolations("core/x.ts", `writeFileSync(\`\${cache}/fired.json\`, "[]")`)).toHaveLength(1);
		expect(itemViolations("core/x.ts", 'db.run("UPDATE items SET notification_count = 0")')).toHaveLength(2);
		expect(itemViolations("core/x.ts", 'run("INSERT INTO items (source) VALUES (?)")')).toHaveLength(1);
		expect(itemViolations("core/x.ts", "item.notificationCount += 1;")).toHaveLength(1);
		expect(itemViolations("core/x.ts", "if (now >= item.nextNotificationAt) send();")).toHaveLength(1);
		expect(itemViolations("core/engine/engine.ts", `readFileSync(\`\${d}/fired.json\`)`)).toHaveLength(1);
		// What is allowed: the owners, comments, tests of a read, and the words in prose.
		expect(itemViolations("core/store/sqlite-items.ts", 'run("UPDATE items SET notification_count = ?")')).toEqual([]);
		expect(
			itemViolations("core/items/notification.ts", "const due = s.nextNotificationAt; if (now >= due) {}"),
		).toEqual([]);
		expect(
			itemViolations(
				"core/x.ts",
				"// no sticky flag, no seen list: the items decide\nconst n = item.notificationCount;",
			),
		).toEqual([]);
		expect(itemViolations("core/x.ts", "const ids = new Set<string>(); const sees = 1;")).toEqual([]);
	});
});
