import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useCoreObsObsFixtures() {
	const dirs: string[] = [];

	const scratch = () => {
		const d = mkdtempSync(`${tmpdir()}/chamberlain-obs-`);
		dirs.push(d);
		return d;
	};

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	return { scratch };
}
