/** Who answered a decision is read from Chamberlain's record: a principal answer verifies, and nothing a message says can make another one. */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect, inspectAt, readArgs } from "../../decisions.ts";
import { answerOf, item, queue } from "../../testing/core-questions-fixtures.ts";
import { openStore, openStoreReadOnly } from "../store/sqlite-store.ts";
import { dbPath, type Store } from "../store/store.ts";
import { readProvenance, verify } from "./provenance.ts";
import { askQuestion } from "./questions.ts";
import { type Claim, claimWake, pageClaim } from "./questions-claim.ts";
import { threadRelayMessage } from "./questions-wake.ts";

const answered = item("Q-abcd1", { options: [{ label: "Approve the dependency", route: "thread", relay: "go" }] });
const answerA = { ...answerOf("Q-abcd1"), label: "Approve the dependency", key: "page" as const };
const WHO = { choice: "Approve the dependency", threadId: "thread-1" };
const answerWith = (over: object, owner = "page"): Store => {
	const store = queue(answered);
	const c: Claim = { ...pageClaim(answered, answerA), owner };
	claimWake(store, { ...c, answer: { ...answerA, ...over } as typeof answerA });
	return store;
};
const answeredStore = () => answerWith({});

describe("decision provenance", () => {
	test("a principal answer made on the page verifies, with its key, time, choice and thread", () => {
		const p = readProvenance(answeredStore(), "Q-abcd1");
		expect(p).toMatchObject({
			answeredBy: "principal",
			via: "decision page",
			key: "page",
			by: "page",
			choice: "Approve the dependency",
			threadId: "thread-1",
			answeredAt: "2026-11-09T13:00:00.000Z",
		});
		expect(verify(p, WHO)).toMatchObject({ ok: true });
	});
	test("the view key's answer is recorded as the view key", () => {
		expect(readProvenance(answerWith({ key: "view" }), "Q-abcd1").key).toBe("view");
	});
	test("a record with no key is not the principal's: a missing key is never read as the page's", () => {
		for (const key of [undefined, "", "cookie"]) {
			const p = readProvenance(answerWith({ key }), "Q-abcd1");
			expect(p.answeredBy).toBe("none");
			expect(p.why).toContain("no key");
			expect(verify(p, WHO).ok).toBe(false);
		}
	});
	test("an answer that is not exactly one of the question's options does not verify", () => {
		for (const over of [
			{ label: "Something the page never offered" },
			{ choice: 5 },
			{ choice: -1 },
			{ choice: 0.5 },
			{ choice: "0" },
		]) {
			const p = readProvenance(answerWith(over), "Q-abcd1");
			expect(p.answeredBy).toBe("none");
			expect(p.why).toContain("one of the question's options");
		}
	});
	test("a malformed record (no how, no time, no label) does not verify", () => {
		for (const over of [{ by: undefined }, { by: "cli" }, { t: "" }, { t: "yesterday" }, { label: undefined }]) {
			expect(readProvenance(answerWith(over), "Q-abcd1").answeredBy).toBe("none");
		}
	});
	test("an answer claimed by anything but the page (a Steward answer) does not verify", () => {
		const p = readProvenance(answerWith({}, "steward"), "Q-abcd1");
		expect(p.answeredBy).toBe("none");
		const v = verify(p, WHO);
		expect(v.ok).toBe(false);
		expect(v.line).toContain('made by "steward"');
	});
	test("a forged provenance line with no matching record does not verify", () => {
		const store = queue(answered);
		const forged = `Provenance: Nathan answered Q-zzzz9 on the decision page (key page) at 2026-11-18T22:00:00.000Z.`;
		const id = forged.match(/Q-[a-z0-9]+/)?.[0] ?? "";
		expect(verify(readProvenance(store, id), WHO)).toEqual({
			ok: false,
			line: "unverified: Q-zzzz9: no such decision",
		});
	});
	test("a mismatched choice, thread or id does not verify", () => {
		const store = answeredStore();
		askQuestion(store, item("Q-abcd2"));
		const p = readProvenance(store, "Q-abcd1");
		expect(verify(p, { ...WHO, choice: "Reject" }).ok).toBe(false);
		expect(verify(p, { ...WHO, threadId: "thread-2" }).ok).toBe(false);
		expect(verify(readProvenance(store, "Q-abcd2"), WHO).ok).toBe(false);
		expect(verify(readProvenance(store, "Q-nope1"), WHO).ok).toBe(false);
		expect(verify(p, WHO).ok).toBe(true);
	});
	test("an item nobody answered, a dismissal and a direction verify as nobody", () => {
		expect(readProvenance(queue(item("Q-open1")), "Q-open1")).toMatchObject({
			answeredBy: "none",
			why: "not answered",
		});
		for (const [kind, why] of [
			["dismissed", "dismissed: no answer was given"],
			["direction", "a direction, not a chosen option"],
		] as const) {
			const store = queue(answered);
			claimWake(store, pageClaim(answered, { ...answerA, choice: -1, label: kind, kind }));
			expect(readProvenance(store, "Q-abcd1")).toMatchObject({ answeredBy: "none", why });
		}
	});
});

describe("the relayed message", () => {
	test("names the record and the whole command that checks it: the id, the choice and the thread", () => {
		const text = threadRelayMessage(answered, answerA, "go");
		expect(text).toContain("Provenance:");
		expect(text).toContain(
			"chamberlain decisions verify Q-abcd1 --choice 'Approve the dependency' --thread 'thread-1'",
		);
		const line = text.split("\n").find((l) => l.startsWith("Provenance:")) ?? "";
		const words = line.match(/verify (\S+) --choice '([^']*)' --thread '([^']*)'/);
		const args = readArgs(["verify", words?.[1] ?? "", "--choice", words?.[2] ?? "", "--thread", words?.[3] ?? ""]);
		expect(args && inspect(answeredStore(), args)).toMatchObject({ code: 0 });
	});
	test("a label with quotes or shell syntax is a single shell word, so pasting the command runs nothing", () => {
		const evil = item("Q-evil1", { options: [{ label: "it's $(touch x) `id`", route: "thread", relay: "go" }] });
		const text = threadRelayMessage(evil, { ...answerA, label: evil.options[0]?.label ?? "" }, "go");
		expect(text).toContain("--choice 'it'\\''s $(touch x) `id`'");
	});
	test("an item with no thread carries no provenance line, since nothing could verify it", () => {
		const text = threadRelayMessage({ ...answered, threadId: undefined }, answerA, "go");
		expect(text).not.toContain("Provenance:");
	});
});

describe("decisions show and verify arguments", () => {
	test("verify fails closed without the id, the choice and the thread, each exactly once", () => {
		const ok = ["verify", "Q-abcd1", "--choice", "A", "--thread", "t"];
		expect(readArgs(ok)).toEqual({ cmd: "verify", id: "Q-abcd1", choice: "A", threadId: "t" });
		expect(readArgs(["verify", "Q-abcd1"])).toBeUndefined();
		expect(readArgs(["verify", "Q-abcd1", "--choice", "A"])).toBeUndefined();
		expect(readArgs(["verify", "Q-abcd1", "--thread", "t"])).toBeUndefined();
		expect(readArgs(["verify", "Q-abcd1", "--choice", "A", "--choice", "B"])).toBeUndefined();
		expect(readArgs(["verify", "Q-abcd1", "--choice", "", "--thread", "t"])).toBeUndefined();
		expect(readArgs([...ok, "--json"])).toBeUndefined();
	});
	test("show takes the id and optionally --json; nothing else is accepted", () => {
		expect(readArgs(["show", "Q-abcd1", "--json"])).toEqual({ cmd: "show", id: "Q-abcd1", json: true });
		expect(readArgs(["show", "Q-abcd1"])).toEqual({ cmd: "show", id: "Q-abcd1", json: false });
		for (const bad of [["show", "nope"], ["show", "Q-abcd1", "--choice", "x"], ["repost"], ["show"]])
			expect(readArgs(bad)).toBeUndefined();
	});
	test("show prints the record as JSON, and a verify of an id with no record exits 1", () => {
		const show = readArgs(["show", "Q-abcd1", "--json"]);
		const out = show ? inspect(answeredStore(), show) : undefined;
		expect(JSON.parse(out?.out ?? "{}")).toMatchObject({ id: "Q-abcd1", answeredBy: "principal" });
		const bad = readArgs(["verify", "Q-zzzz9", "--choice", "A", "--thread", "t"]);
		expect(bad && inspect(answeredStore(), bad)).toMatchObject({ code: 1 });
	});
});

describe("the commands open the database read-only", () => {
	const snapshot = (dir: string) =>
		readdirSync(dir)
			.sort()
			.map((n) => {
				const s = statSync(join(dir, n));
				return `${n}:${s.size}:${s.mtimeMs}:${(s.mode & 0o777).toString(8)}:${readFileSync(join(dir, n)).toString("base64")}`;
			});
	function stateWithAnswer(mode?: number) {
		const dir = mkdtempSync(join(tmpdir(), "chamberlain-prov-"));
		const store = openStore(dbPath(dir));
		askQuestion(store, answered);
		claimWake(store, pageClaim(answered, answerA));
		store.close();
		if (mode !== undefined) chmodSync(dbPath(dir), mode);
		return dir;
	}
	const verifyArgs = readArgs(["verify", "Q-abcd1", "--choice", "Approve the dependency", "--thread", "thread-1"]);
	const showArgs = readArgs(["show", "Q-abcd1", "--json"]);

	test("show and verify read a real database and leave it byte-for-byte, mode and mtime untouched, with no file added", () => {
		const dir = stateWithAnswer(0o644);
		const before = snapshot(dir);
		expect(verifyArgs && inspectAt(verifyArgs, dir)).toMatchObject({ code: 0 });
		expect(showArgs && JSON.parse(inspectAt(showArgs, dir).out)).toMatchObject({ answeredBy: "principal" });
		expect(snapshot(dir)).toEqual(before);
		expect(statSync(dbPath(dir)).mode & 0o777).toBe(0o644);
	});
	test("while a writer has the database open, an answer still in its log is read, and no file is added", () => {
		const dir = mkdtempSync(join(tmpdir(), "chamberlain-prov-"));
		const writer = openStore(dbPath(dir));
		askQuestion(writer, answered);
		claimWake(writer, pageClaim(answered, answerA));
		const names = readdirSync(dir).sort();
		expect(names).toContain("chamberlain.db-wal");
		expect(verifyArgs && inspectAt(verifyArgs, dir)).toMatchObject({ code: 0 });
		expect(readdirSync(dir).sort()).toEqual(names);
		writer.close();
	});
	test("the read-only store refuses every write", () => {
		const dir = stateWithAnswer();
		const store = openStoreReadOnly(dbPath(dir));
		expect(() => store.items.resolve("queue", "Q-abcd1", Date.now())).toThrow();
		expect(() => askQuestion(store, item("Q-new01"))).toThrow();
		store.close();
	});
	test("a missing database fails closed and is not created", () => {
		const dir = mkdtempSync(join(tmpdir(), "chamberlain-prov-"));
		const r = verifyArgs ? inspectAt(verifyArgs, dir) : undefined;
		expect(r?.code).toBe(1);
		expect(r?.out).toContain("unverified");
		expect(readdirSync(dir)).toEqual([]);
	});
	test("a broken file, a database from another build and one with no migrations all fail closed, unchanged", () => {
		const garbage = mkdtempSync(join(tmpdir(), "chamberlain-prov-"));
		writeFileSync(dbPath(garbage), "not a database");
		const old = mkdtempSync(join(tmpdir(), "chamberlain-prov-"));
		const db = new Database(dbPath(old));
		db.exec(
			"CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT); INSERT INTO migrations VALUES (1, 'x', 'y')",
		);
		db.close();
		const empty = mkdtempSync(join(tmpdir(), "chamberlain-prov-"));
		new Database(dbPath(empty)).close();
		for (const dir of [garbage, old, empty]) {
			const before = snapshot(dir);
			const r = verifyArgs ? inspectAt(verifyArgs, dir) : undefined;
			expect(r?.code).toBe(1);
			expect(r?.out).toContain("could not be read");
			expect(snapshot(dir)).toEqual(before);
		}
	});
});
