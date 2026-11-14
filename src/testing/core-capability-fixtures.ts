import { afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useCoreCapabilityFixtures() {
	const dirs: string[] = [];

	const conf = () => {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-cap-`);
		dirs.push(root);
		const c = `${root}/conf`;
		mkdirSync(c, { mode: 0o700 });
		return c;
	};

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const mode = (p: string) => statSync(p).mode & 0o777;

	const cookieOf = (setCookie: string) => setCookie.split(";")[0]!;

	return { conf, mode, cookieOf };
}
