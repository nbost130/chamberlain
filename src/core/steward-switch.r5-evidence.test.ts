/**
 * Sol R5 (split PR B): commit atomicity, C5 publish spy + dir-fsync propagation, executed publish-ref CLI.
 */
import { describe, expect, test } from "bun:test";
import {
	chmodSync,
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
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

	test("directory fsync exception propagates (M2)", () => {
		const w = confWorld();
		const ops: PublishFs = {
			mkdirSync,
			existsSync,
			openSync,
			writeSync,
			fsyncSync: (fd) => {
				if (fstatSync(fd).isDirectory()) throw new Error("injected directory fsync failure");
				return fsyncSync(fd);
			},
			closeSync,
			chmodSync,
			linkSync,
			unlinkSync,
		};
		expect(() =>
			withPublishFs(ops, () => publishSwitchRef(w.conf, "fsync-id", "wake", "https://fake.example/fsync\n")),
		).toThrow("injected directory fsync failure");
	});
});

describe("R5 publish-ref CLI (executed)", () => {
	test("real cli.ts steward publish-ref writes private immutable ref; duplicate refuses", async () => {
		const w = confWorld();
		const input = `${w.root}/input`;
		writeFileSync(input, "https://fake.example/review", { mode: 0o600 });
		const cli = new URL("../cli.ts", import.meta.url).pathname;
		const args = ["bun", cli, "steward", "publish-ref", "review-id", "wake", "--file", input, "--live"];
		const env = { ...process.env, CHAMBERLAIN_CONF: w.conf, CHAMBERLAIN_STATE: w.state };
		const p = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
		const [rc, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
		expect({ rc, err }).toEqual({ rc: 0, err: "" });
		const path = `${w.conf}/secrets/steward/review-id.wake`;
		expect(existsSync(path)).toBe(true);
		expect(readFileSync(path, "utf8")).toBe("https://fake.example/review\n");
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(out).not.toContain("https://");
		expect(out).toContain("published review-id.wake");

		const again = Bun.spawn(args, { env, stdout: "ignore", stderr: "pipe" });
		const refused = await new Response(again.stderr).text();
		await again.exited;
		expect(refused).toContain("ref already exists");
		expect(readFileSync(path, "utf8")).toBe("https://fake.example/review\n");
	});
});
