/** A T3 thread's links (./links.ts): the environment each server's links name, the id as T3 writes it, and no link when unsure. */
import { describe, expect, test } from "bun:test";
import { conformance } from "../../core/adapter.ts";
import { createT3Adapter } from "./index.ts";
import { DEFAULT_APP_SCHEME, ENV_RETRY_MS, linkSegment, t3Linker, t3ThreadLinks } from "./links.ts";

const UUID = "1f0c2b9e-4a7d-4c3e-9b1a-2d5e6f708192";

describe("t3ThreadLinks", () => {
	test("names the environment and the thread in both of T3's shapes", () => {
		expect(t3ThreadLinks("env-1", UUID)).toEqual({
			ref: `t3-thread://v2/env-1/${UUID}`,
			app: `t3code://threads/env-1/${UUID}`,
		});
	});
	test("writes a launched thread's colons as T3 itself does, unencoded", () => {
		expect(t3ThreadLinks("env-1", "mcp:launch:0a1b2c").ref).toBe("t3-thread://v2/env-1/mcp:launch:0a1b2c");
		expect(t3ThreadLinks("env-1", "mcp:launch:0a1b2c").app).toBe("t3code://threads/env-1/mcp:launch:0a1b2c");
	});
	test("encodes anything that would end or split the link, and keeps the colons", () => {
		expect(linkSegment("a b/c:d")).toBe("a%20b%2Fc:d");
		expect(linkSegment('x")<y')).toBe("x%22)%3Cy");
		expect(t3ThreadLinks("env-1", "a/b").ref).toBe("t3-thread://v2/env-1/a%2Fb");
	});
	test("gives no link at all without an environment or a thread", () => {
		expect(t3ThreadLinks(undefined, UUID)).toEqual({});
		expect(t3ThreadLinks("", UUID)).toEqual({});
		expect(t3ThreadLinks("env-1", "")).toEqual({});
	});
	test("an app scheme from the entry replaces t3code; one that is not a scheme drops only the app link", () => {
		expect(DEFAULT_APP_SCHEME).toBe("t3code");
		expect(t3ThreadLinks("env-1", "t1", "t3code-preview").app).toBe("t3code-preview://threads/env-1/t1");
		expect(t3ThreadLinks("env-1", "t1", "javascript:alert(1)//")).toEqual({ ref: "t3-thread://v2/env-1/t1" });
	});
});

describe("t3Linker: which environment a server's links name", () => {
	const never = async () => {
		throw Error("the environment document must not be read");
	};
	test("a linked server: its environmentId, with no read of the server", () => {
		const l = t3Linker({ origin: "http://mac:3773", environmentId: "env-mac" }, { read: never });
		expect(l.links("t1").ref).toBe("t3-thread://v2/env-mac/t1");
	});
	test("linkEnvironmentId wins over environmentId, and needs no read either", () => {
		const l = t3Linker({ origin: "http://h", environmentId: "env-a", linkEnvironmentId: "env-b" }, { read: never });
		expect(l.links("t1").ref).toBe("t3-thread://v2/env-b/t1");
	});
	test("the home server (no environmentId): no link until its own environment document is read, then its id", async () => {
		const asked: string[] = [];
		const l = t3Linker(
			{ origin: "http://127.0.0.1:3773" },
			{
				read: async (origin) => {
					asked.push(origin);
					return { environmentId: "env-home" } as never;
				},
			},
		);
		expect(l.links("t1")).toEqual({});
		await l.ready();
		expect(l.links("t1")).toEqual({ ref: "t3-thread://v2/env-home/t1", app: "t3code://threads/env-home/t1" });
		await l.ready();
		expect(asked).toEqual(["http://127.0.0.1:3773"]);
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
		expect(l.links("t1")).toEqual({});
		await l.ready();
		expect(reads).toBe(1);
		now += ENV_RETRY_MS;
		answer = { environmentId: "env-late" };
		await l.ready();
		expect(reads).toBe(2);
		expect(l.links("t1").ref).toBe("t3-thread://v2/env-late/t1");
	});
	test("an environment id that is not one (a slash, a space, not a string) is no link, never a broken one", async () => {
		for (const environmentId of ["a/b", "has space", 42, ""]) {
			const l = t3Linker({ origin: "http://h" }, { read: async () => ({ environmentId }) as never });
			await l.ready();
			expect(l.links("t1")).toEqual({});
		}
	});
	test("a read that throws is a failed read", async () => {
		const l = t3Linker({ origin: "http://h" }, { read: never });
		await l.ready();
		expect(l.links("t1")).toEqual({});
	});
	test("the entry's appScheme names the app", () => {
		const l = t3Linker({ origin: "http://h", environmentId: "e", appScheme: "t3code-dev" }, { read: never });
		expect(l.links("t1").app).toBe("t3code-dev://threads/e/t1");
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
	expect(a.threadLinks!("t1")).toEqual({ ref: "t3-thread://v2/env-mac/t1", app: "t3code://threads/env-mac/t1" });
});
