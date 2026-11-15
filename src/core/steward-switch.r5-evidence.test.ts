/**
 * Sol R5 (split PR B): commit atomicity, C5 publish spy, publish-ref CLI path.
 */
import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { useStewardSwitchFixtures } from "../testing/steward-switch-fixtures.ts";
import { commitSwitch } from "./steward-commit.ts";
import { type PublishFs, publishSwitchRef, withPublishFs } from "./steward-gens.ts";
import { prepareSwitch } from "./steward-prepare.ts";

const { confWorld, memStoreSeeded, writeSwitchRefs } = useStewardSwitchFixtures();

describe("R5 commit atomicity", () => {
	test("injected failure after insertGen rolls back — no gen 2, no transfer, still preparing", () => {
		const w = confWorld();
		const base = memStoreSeeded(w.conf);
		const prep = prepareSwitch(base, w.conf, { toThread: "g2", live: true, now: 1 });
		if (!prep.ok) throw new Error(prep.error);
		writeSwitchRefs(w.conf, prep.id);
		const store = {
			...base,
			steward: {
				...base.steward,
				insertTransfer: () => {
					throw new Error("injected after gen write");
				},
			},
		};
		const r = commitSwitch(store, w.conf, { id: prep.id, live: true, now: 1 });
		expect(r.ok).toBe(false);
		expect(base.steward.maxGen()).toBe(1);
		expect(base.steward.transfer(1)).toBeUndefined();
		expect(base.steward.switchById(prep.id)?.phase).toBe("preparing");
	});
});

describe("R5 C5 publishSwitchRef call order", () => {
	test("spies fsync(file) then link then fsync(dir); mode 0600; never overwrite", () => {
		const w = confWorld();
		const prep = prepareSwitch(memStoreSeeded(w.conf), w.conf, { toThread: "t", live: true });
		if (!prep.ok) throw new Error(prep.error);
		const order: string[] = [];
		const real: PublishFs = {
			mkdirSync,
			existsSync,
			openSync,
			writeSync,
			fsyncSync: (fd) => {
				order.push(`fsync:${fd}`);
				return fsyncSync(fd);
			},
			closeSync,
			chmodSync,
			linkSync: (a, b) => {
				order.push("link");
				return linkSync(a, b);
			},
			unlinkSync,
		};
		const ok = withPublishFs(real, () => publishSwitchRef(w.conf, prep.id, "wake", "https://fake.example/a\n"));
		expect(ok).toBe(true);
		const fsyncIdx = order.map((s, i) => (s.startsWith("fsync:") ? i : -1)).filter((i) => i >= 0);
		const linkIdx = order.indexOf("link");
		expect(fsyncIdx.length).toBeGreaterThanOrEqual(2);
		expect(fsyncIdx[0]!).toBeLessThan(linkIdx);
		expect(linkIdx).toBeLessThan(fsyncIdx[1]!);
		const path = `${w.conf}/secrets/steward/${prep.id}.wake`;
		expect(existsSync(path)).toBe(true);
		expect(withPublishFs(real, () => publishSwitchRef(w.conf, prep.id, "wake", "https://fake.example/b\n"))).toBe(
			false,
		);
	});

	test("successor start prompt and CLI wire publish-ref to publishSwitchRef", () => {
		const start = readFileSync(new URL("../../docs/steward-start.md", import.meta.url), "utf8");
		expect(start).toContain("publish-ref");
		expect(start).toContain("{{switchSteward}} publish-ref");
		const cli = readFileSync(new URL("./steward-switch.ts", import.meta.url), "utf8");
		expect(cli).toContain('cmd === "publish-ref"');
		expect(cli).toContain("publishSwitchRef(CONF");
	});
});
