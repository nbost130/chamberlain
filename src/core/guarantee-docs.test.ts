/**
 * The delivery guarantee as documented must say what the code does (S3). Each behaviour has its own test (relay.test.ts, crash.test.ts);
 * this pins the prose to them, so an overstated sentence ("every row is POSTed until one is accepted", "within a second or two") cannot return.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const arch = read("docs/ARCHITECTURE.md");
const section = arch.slice(arch.indexOf("## Delivery guarantees and the windows that remain"), arch.indexOf("## Where state lives"));
const norm = (s: string) => s.replace(/\s+/g, " ").replace(/> /g, "");

const sources = (dir: string): string[] => readdirSync(join(ROOT, dir)).flatMap((n) => {
	const p = join(dir, n);
	return statSync(join(ROOT, p)).isDirectory() ? (n === "node_modules" ? [] : sources(p)) : /\.(ts|md)$/.test(n) ? [p] : [];
});

describe("the documented delivery guarantee matches the behaviour", () => {
	const text = norm(section);

	test("it is at-least-once with bounded retries, and says a dead letter is not a delivery and can have zero POSTs", () => {
		expect(text).toContain("at-least-once with bounded retries");
		expect(text).toContain("until one POST is accepted or it has used `maxAttempts` attempts");
		expect(text).toContain("A dead letter is not a delivery");
		expect(text).toContain("**zero** accepted POSTs");
		expect(text).toContain("An attempt is not a POST");
		expect(text).not.toContain("Every outbox row is POSTed until one POST is accepted");
	});

	test("the cap is per row between explicit retries", () => {
		expect(text).toContain("between explicit retries");
		expect(text).toContain("(n + 1) * maxAttempts");
	});

	test("pickup latency is conditional, sends are sequential, and order is not strict", () => {
		expect(text).toContain("Pickup latency is conditional");
		expect(text).toContain("head-of-line blocking");
		expect(text).toContain("delays every row behind it");
		expect(text).toContain("not strict order");
		expect(text).toContain("The relay sets no deadline of its own");
	});

	test("retention and the singleton's limits, including the network filesystem, are stated", () => {
		expect(text).toContain("tombstone");
		expect(text).toContain("not supported on a network filesystem");
		expect(text).toContain("`state-on-network-filesystem`");
		expect(text).toContain("hard links");
	});

	test("the singleton states the real macOS semantics: flock and SQLite's fcntl locks conflict there, so the lock is on the state directory", () => {
		const singleton = norm(read("src/core/singleton.ts").slice(0, read("src/core/singleton.ts").indexOf("import { dlopen")).replace(/\n \* ?/g, " "));
		const glossary = norm(read("docs/GLOSSARY.md"));
		expect(text).toContain("on macOS, as on FreeBSD, `flock` and `fcntl` locks are kept on the same per-file lock list and **do conflict**");
		expect(text).toContain("SQLite never locks a directory");
		expect(singleton).toContain("on macOS, as on the BSDs, `flock` and `fcntl` locks on one file DO conflict");
		for (const [where, t] of [["ARCHITECTURE", text], ["singleton.ts", singleton], ["GLOSSARY", glossary], ["README", norm(read("README.md"))]] as const) {
			expect(t, where).not.toMatch(/on Linux and macOS,? (`flock` and `fcntl` locks )?are independent|on Linux and macOS it is independent/i);
		}
	});

	test("nothing in the docs or the code promises pickup 'within a second or two' without condition", () => {
		const hits = [...sources("docs"), ...sources("src"), "README.md", "CHANGELOG.md"].filter((p) => !p.endsWith(".test.ts") && /within a second or two/i.test(read(p)));
		expect(hits.map((p) => relative(".", p))).toEqual([]);
	});

	test("the glossary names the terms the guarantee uses", () => {
		const g = read("docs/GLOSSARY.md");
		for (const term of ["At-least-once delivery with bounded retries", "Head-of-line blocking", "Best-effort ordering", "Dead-letter queue", "Tombstone"]) expect(g).toContain(term);
	});
});

describe("the one-relay lock's lifetime is documented exactly (close-on-exec covers an exec, not a fork without one)", () => {
	const lock = norm(section.slice(section.indexOf("**One relay.**"), section.indexOf("4. **A row is immutable")));
	const header = norm(read("src/core/singleton.ts").slice(0, read("src/core/singleton.ts").indexOf('import { dlopen')));

	test("ARCHITECTURE and the singleton's header say close-on-exec protects exec'd children and a fork without exec would inherit the lock", () => {
		for (const [where, text] of [["ARCHITECTURE", lock], ["singleton.ts", header]] as const) {
			expect(text, where).toContain("close-on-exec");
			expect(text, where).toMatch(/fork \*{0,2}without\*{0,2} an exec/i);
			expect(text, where).toMatch(/share the open file description/);
			expect(text, where).toContain("No production path forks without exec");
		}
		expect(lock).not.toContain("so no child of the daemon keeps it");
	});

	test("and it is true: no production module forks without exec (the only foreign code called through bun:ffi is flock and errno)", () => {
		const prod = sources("src").filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
		const ffi = prod.filter((f) => /\bdlopen\s*\(/.test(read(f)));
		expect(ffi.map((f) => relative(ROOT, join(ROOT, f)))).toEqual(["src/core/singleton.ts"]);
		const code = read("src/core/singleton.ts");
		expect([...code.matchAll(/\b(flock|errno|__errno_location|__error|fork|vfork|clone|posix_spawn)\s*:\s*\{\s*args/g)].map((m) => m[1]).sort()).toEqual(["flock"]);
		expect(code).toMatch(/\[errnoSymbol\]: \{ args: \[\]/);
		for (const f of prod) expect(read(f), f).not.toMatch(/node:cluster|\bos\.fork\b|\bsyscall\s*\(/);
	});
});
