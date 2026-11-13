import { describe, expect, test } from "bun:test";
import { compatWarning, readEnvironment, T3_TESTED } from "./compat.ts";

describe("compatWarning", () => {
	const ok = { serverVersion: T3_TESTED.min, orchestrationProtocolVersion: T3_TESTED.orchestrationProtocol };
	test("both ends of the tested range are inside it", () => {
		expect(compatWarning(ok)).toBeUndefined();
		expect(compatWarning({ ...ok, serverVersion: T3_TESTED.max })).toBeUndefined();
	});
	test("older and newer versions warn, naming the range", () => {
		expect(compatWarning({ ...ok, serverVersion: "0.0.9" })).toContain(`outside the tested range ${T3_TESTED.min} to ${T3_TESTED.max}`);
		expect(compatWarning({ ...ok, serverVersion: "0.2.0" })).toContain("T3 0.2.0 is outside");
		expect(compatWarning({ ...ok, serverVersion: "1.0.0" })).toContain("outside");
	});
	test("a different protocol warns even when the version is fine", () => {
		expect(compatWarning({ ...ok, orchestrationProtocolVersion: 3 })).toContain("orchestration protocol 3, not 2");
		expect(compatWarning({ serverVersion: T3_TESTED.min })).toContain("orchestration protocol undefined");
	});
	test("an unreadable server is reported, never assumed fine", () => {
		expect(compatWarning(undefined)).toContain("compatibility is unchecked");
		expect(compatWarning({ ...ok, serverVersion: undefined })).toContain("no usable version");
		expect(compatWarning({ ...ok, serverVersion: "dev" })).toContain("no usable version");
	});
	test("the warning points at the docs", () => expect(compatWarning(undefined, T3_TESTED)).toBeDefined());
	test("the range is a well-formed, ordered pair", () => {
		expect(Bun.semver.order(T3_TESTED.min, T3_TESTED.max)).toBeLessThanOrEqual(0);
		expect(T3_TESTED.min).toMatch(/^\d+\.\d+\.\d+$/);
	});
});

describe("readEnvironment", () => {
	const fake = (status: number, body: unknown) => (async (url: URL | string) => {
		expect(String(url)).toBe("http://t3.test/.well-known/t3/environment");
		return new Response(JSON.stringify(body), { status });
	}) as unknown as typeof fetch;
	test("reads the unauthenticated environment document", async () => {
		expect(await readEnvironment("http://t3.test", fake(200, { serverVersion: "0.1.9", orchestrationProtocolVersion: 2 }))).toEqual({ serverVersion: "0.1.9", orchestrationProtocolVersion: 2 });
	});
	test("an error status, a non-object body and a network failure are all undefined, never a throw", async () => {
		expect(await readEnvironment("http://t3.test", fake(500, {}))).toBeUndefined();
		expect(await readEnvironment("http://t3.test", fake(200, "nope"))).toBeUndefined();
		expect(await readEnvironment("http://t3.test", (async () => { throw Error("refused"); }) as unknown as typeof fetch)).toBeUndefined();
	});
});
