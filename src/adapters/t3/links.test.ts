/** A T3 thread's links (./links.ts): the thread ids T3 issues, the environment each server's links name, and no link when unsure. */
import { describe, expect, test } from "bun:test";
import { conformance } from "../../core/adapter.ts";
import { createT3Adapter } from "./index.ts";
import { DEFAULT_APP_SCHEME, ENV_REFRESH_MS, ENV_RETRY_MS, isT3ThreadId, t3Linker, t3ThreadLinks } from "./links.ts";

const UUID = "1f0c2b9e-4a7d-4c3e-9b1a-2d5e6f708192";
const LAUNCHED = `mcp:launch:${"0a1b2c3d".repeat(8)}`;
/** One of each shape T3 issues, as they appear in a 0.1.9 database. */
const T3_IDS = [
	UUID,
	`mcp:${UUID}`,
	LAUNCHED,
	"thread:delegated-task:command%3Amcp%3A0031c8a2-1482-4440-93fc-df49fc0e2dcb%3Adelegate-task%3A703-rule-round4-sql-1",
	"thread:provider:claudeAgent:native-thread:provider-thread%3Aprovider%3AclaudeAgent",
	"thread:project:1370cbb9-2384-4c21-97b5-7b4e9cc203af:2a2b68e6-13fd-4f3c-8d1e-081b84e0cb2d",
	"import:claudeAgent:9d3c1a2b-0000-4000-8000-000000000001",
];

describe("isT3ThreadId: only the shapes T3 issues", () => {
	test("accepts each shape", () => {
		for (const id of T3_IDS) expect([id, isT3ThreadId(id)]).toEqual([id, true]);
	});
	test("rejects anything else", () => {
		for (const id of [
			"",
			":",
			"garbage",
			"t1",
			"a/b",
			"mcp:launch:NOTHEX",
			`mcp:launch:${"ab".repeat(31)}`,
			`mcp:launch:${"AB".repeat(32)}`,
			"mcp:not-a-uuid",
			`${UUID}/x`,
			`${UUID} `,
			"thread:",
			"thread:delegated-task",
			"thread:Delegated:x",
			"thread:delegated-task:has space",
			"thread:delegated-task:a(b)",
			"thread:delegated-task:%zz",
			"import:only-one",
			`thread:x:${"a".repeat(600)}`,
		])
			expect([id, isT3ThreadId(id)]).toEqual([id, false]);
	});
});

describe("t3ThreadLinks", () => {
	test("names the environment and the thread in both of T3's shapes", () => {
		expect(t3ThreadLinks("env-1", UUID)).toEqual({
			ref: `t3-thread://v2/env-1/${UUID}`,
			app: `t3code://threads/env-1/${UUID}`,
		});
	});
	test("writes an id as T3 does: colons and its own percent escapes unchanged", () => {
		expect(t3ThreadLinks("env-1", LAUNCHED)!.ref).toBe(`t3-thread://v2/env-1/${LAUNCHED}`);
		const derived = T3_IDS[3]!;
		expect(t3ThreadLinks("env-1", derived)!.app).toBe(`t3code://threads/env-1/${derived}`);
	});
	test("an id T3 does not issue is not a thread: undefined, so no override links it either", () => {
		for (const id of ["a/b", "garbage", ":", "mcp:launch:NOTHEX"]) expect(t3ThreadLinks("env-1", id)).toBeUndefined();
	});
	test("a thread id with no environment, or one that is not an id, gives no link", () => {
		expect(t3ThreadLinks(undefined, UUID)).toEqual({});
		expect(t3ThreadLinks("", UUID)).toEqual({});
		expect(t3ThreadLinks("env/1", UUID)).toEqual({});
	});
	test("an app scheme from the entry replaces t3code; one that is not a scheme drops only the app link", () => {
		expect(DEFAULT_APP_SCHEME).toBe("t3code");
		expect(t3ThreadLinks("env-1", UUID, "t3code-preview")!.app).toBe(`t3code-preview://threads/env-1/${UUID}`);
		expect(t3ThreadLinks("env-1", UUID, "javascript:alert(1)//")).toEqual({ ref: `t3-thread://v2/env-1/${UUID}` });
	});
});

describe("t3Linker: which environment a server's links name", () => {
	const never = async () => {
		throw Error("the environment document must not be read");
	};
	test("a linked server: its environmentId, with no read of the server", () => {
		const l = t3Linker({ origin: "http://mac:3773", environmentId: "env-mac" }, { read: never });
		expect(l.links(UUID)!.ref).toBe(`t3-thread://v2/env-mac/${UUID}`);
	});
	test("linkEnvironmentId wins over environmentId, and needs no read either", () => {
		const l = t3Linker({ origin: "http://h", environmentId: "env-a", linkEnvironmentId: "env-b" }, { read: never });
		expect(l.links(UUID)!.ref).toBe(`t3-thread://v2/env-b/${UUID}`);
	});
	test("the home server (no environmentId): links answers at once, reads in the background, then names the id it read", async () => {
		const asked: string[] = [];
		let land: () => void = () => {};
		const l = t3Linker(
			{ origin: "http://127.0.0.1:3773" },
			{
				read: (origin) => {
					asked.push(origin);
					return new Promise((r) => (land = () => r({ environmentId: "env-home" })));
				},
			},
		);
		expect(l.links(UUID)).toEqual({});
		expect(l.links(UUID)).toEqual({});
		expect(asked).toEqual(["http://127.0.0.1:3773"]);
		land();
		await l.ready();
		expect(l.links(UUID)).toEqual({ ref: `t3-thread://v2/env-home/${UUID}`, app: `t3code://threads/env-home/${UUID}` });
	});
	test("the id read is kept, read again only after the refresh age, and kept if that refresh fails", async () => {
		let now = 1_000_000;
		const answers: unknown[] = [{ environmentId: "env-1" }, undefined, { environmentId: "env-2" }];
		let reads = 0;
		const l = t3Linker({ origin: "http://h" }, { read: async () => answers[reads++] as never, now: () => now });
		await l.ready();
		l.links(UUID);
		await l.ready();
		expect(reads).toBe(1);
		now += ENV_REFRESH_MS;
		l.links(UUID);
		await l.ready();
		expect(reads).toBe(2);
		expect(l.links(UUID)!.ref).toBe(`t3-thread://v2/env-1/${UUID}`);
		now += ENV_RETRY_MS;
		await l.ready();
		expect(reads).toBe(3);
		expect(l.links(UUID)!.ref).toBe(`t3-thread://v2/env-2/${UUID}`);
	});
	test("a failed read gives no link, and is not repeated on every call, only after the retry wait", async () => {
		let now = 1_000_000;
		let reads = 0;
		let answer: unknown;
		const l = t3Linker(
			{ origin: "http://h" },
			{
				read: async () => {
					reads++;
					return answer as never;
				},
				now: () => now,
			},
		);
		await l.ready();
		expect(l.links(UUID)).toEqual({});
		await l.ready();
		expect(reads).toBe(1);
		now += ENV_RETRY_MS;
		answer = { environmentId: "env-late" };
		await l.ready();
		expect(reads).toBe(2);
		expect(l.links(UUID)!.ref).toBe(`t3-thread://v2/env-late/${UUID}`);
	});
	test("an environment id that is not one (a slash, a space, not a string) is no link, never a broken one", async () => {
		for (const environmentId of ["a/b", "has space", 42, ""]) {
			const l = t3Linker({ origin: "http://h" }, { read: async () => ({ environmentId }) as never });
			await l.ready();
			expect(l.links(UUID)).toEqual({});
		}
	});
	test("a read that throws is a failed read", async () => {
		const l = t3Linker({ origin: "http://h" }, { read: never });
		await l.ready();
		expect(l.links(UUID)).toEqual({});
	});
	test("the entry's appScheme names the app", () => {
		const l = t3Linker({ origin: "http://h", environmentId: "e", appScheme: "t3code-dev" }, { read: never });
		expect(l.links(UUID)!.app).toBe(`t3code-dev://threads/e/${UUID}`);
	});
});

test("the T3 adapter declares threadLinks and gives a linked server's links", () => {
	const a = createT3Adapter({
		server: {
			name: "mac",
			adapter: "t3",
			origin: "http://mac:3773",
			tokenFile: "read-token",
			environmentId: "env-mac",
		},
		conf: "/nonexistent",
		state: "/nonexistent",
		log: () => {},
		alarm: () => {},
		steward: () => undefined,
		readPrivate: () => undefined,
	});
	expect(conformance(a)).toEqual([]);
	expect(a.threadLinks!(LAUNCHED)).toEqual({
		ref: `t3-thread://v2/env-mac/${LAUNCHED}`,
		app: `t3code://threads/env-mac/${LAUNCHED}`,
	});
	expect(a.threadLinks!("garbage")).toBeUndefined();
});
