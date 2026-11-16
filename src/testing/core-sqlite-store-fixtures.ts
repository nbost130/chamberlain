import { Database } from "bun:sqlite";
import { afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openStore } from "../core/store/sqlite-store.ts";
import type { Store } from "../core/store/store.ts";

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useCoreSqliteStoreFixtures() {
	const open: Store[] = [];

	const dirs: string[] = [];

	afterEach(() => {
		for (const s of open.splice(0)) {
			try {
				s.close();
			} catch {
				/* closed */
			}
		}
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const mem = () => {
		const s = openStore(":memory:");
		open.push(s);
		return s;
	};

	const file = () => {
		const d = mkdtempSync(`${tmpdir()}/chamberlain-store-`);
		dirs.push(d);
		const path = `${d}/chamberlain.db`;
		const s = openStore(path);
		open.push(s);
		return { s, path, d };
	};

	const raw = (path: string) => new Database(path);

	return { open, dirs, mem, file, raw };
}
