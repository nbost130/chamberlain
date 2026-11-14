import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parseServers, readServers, serversDoc } from "./servers.ts";

const main = { name: "main", origin: "http://127.0.0.1:3773", tokenFile: "read-token", adapter: "t3" };
const { adapter: _a, ...unversioned } = main;
const ps = (list: unknown[]) => parseServers({ servers: list });

describe("parseServers", () => {
	test("reads the versioned form and an unversioned one, a server with no adapter being a T3 one", () => {
		expect(parseServers({ schemaVersion: 2, servers: [main] })).toEqual([main]);
		expect(parseServers({ schemaVersion: 1, servers: [unversioned] })).toEqual([main]);
		expect(parseServers({ servers: [unversioned] })).toEqual([main]);
		expect(parseServers(serversDoc([main]))).toEqual([main]);
	});
	test("a server names its adapter, and keeps the keys that adapter reads", () => {
		const herd = { name: "ws", adapter: "herdr", socket: "/run/user/1000/herdr.sock" };
		expect(ps([herd])).toEqual([herd]);
		expect(() => ps([{ name: "x", adapter: "" }])).toThrow("adapter must be a non-empty string");
		expect(() => ps([{ name: "x", adapter: 3 }])).toThrow("adapter must be a non-empty string");
	});
	test("keeps the optional fields", () => {
		const s = { ...main, name: "laptop", environmentId: "env-1", mayBeOffline: true, sshHost: "me@laptop" };
		expect(ps([s])).toEqual([s]);
	});
	test("refuses an entry without a name, and two with one name", () => {
		expect(() => ps([{ origin: "http://x", tokenFile: "t" }])).toThrow("every server needs a name");
		expect(() => ps([main, main])).toThrow("two servers are named main");
		expect(() => parseServers({ servers: "nope" })).toThrow("need");
		expect(() => parseServers(null)).toThrow("need");
		expect(() => parseServers([main])).toThrow("need");
	});
	test("refuses a newer schema", () => expect(() => parseServers({ schemaVersion: 3, servers: [main] })).toThrow("newer Chamberlain"));
});

describe("readServers", () => {
	test("no file is undefined; a world-readable file is refused", () => {
		const d = mkdtempSync(`${tmpdir()}/chamberlain-servers-`);
		expect(readServers(d)).toBeUndefined();
		writeFileSync(`${d}/servers.json`, JSON.stringify(serversDoc([main])));
		chmodSync(`${d}/servers.json`, 0o644);
		expect(() => readServers(d)).toThrow("0600");
		chmodSync(`${d}/servers.json`, 0o600);
		expect(readServers(d)).toEqual([main]);
	});
});
