import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memStore } from "../../testing/store.ts";
import { createPreparePr } from "./engine-prepare-pr.ts";

function confWithPreparePr(preparePr: Record<string, unknown>): string {
	const conf = mkdtempSync(join(tmpdir(), "prep-pr-conf-"));
	writeFileSync(join(conf, "config.json"), JSON.stringify({ schemaVersion: 1, sweep: { preparePr } }), {
		mode: 0o600,
	});
	return conf;
}

describe("createPreparePr timer", () => {
	test("respects intervalMinutes with a fake clock", async () => {
		const conf = confWithPreparePr({
			enabled: true,
			intervalMinutes: 1,
			oneWayMode: "shadow",
			otherMode: "shadow",
			repos: [{ name: "MemberHero", path: "/tmp/no-such-repo" }],
		});
		const store = memStore();
		let now = 1_000_000;
		let polls = 0;
		const exec = async () => {
			polls++;
			return { code: 0, stdout: "daemon: running\n" };
		};
		const prep = createPreparePr({
			store,
			log: () => {},
			outbox: { commit: (fn: () => unknown) => fn() } as never,
			conf,
			listRunning: () => [],
			parkedSinceOf: () => new Map(),
			settledThreadIds: () => new Set(),
			now: () => now,
			exec,
		});
		await prep.tick();
		expect(polls).toBe(2); // one-way + other sources each poll overview
		await prep.tick();
		expect(polls).toBe(2); // still within interval
		now += 60_000;
		await prep.tick();
		expect(polls).toBe(4);
	});

	test("disabled preparePr never polls", async () => {
		const conf = confWithPreparePr({ enabled: false });
		let polls = 0;
		const prep = createPreparePr({
			store: memStore(),
			log: () => {},
			outbox: { commit: (fn: () => unknown) => fn() } as never,
			conf,
			listRunning: () => [],
			parkedSinceOf: () => new Map(),
			settledThreadIds: () => new Set(),
			exec: async () => {
				polls++;
				return { code: 0, stdout: "daemon: running\n" };
			},
		});
		await prep.tick();
		expect(polls).toBe(0);
	});
});
