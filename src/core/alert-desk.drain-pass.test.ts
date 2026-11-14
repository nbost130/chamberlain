/** alert-desk, continued: see alert-desk.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { ev, feed, line, MIB, min, rig, T0 } from "../testing/core-alert-desk-fixtures.ts";
import { ALERT_DESK, DAY_MS, DEFAULTS, parseConfig, readConfig } from "./alert-desk-config.ts";
import { type CrashPoint, CURSOR_KEY, type Cursor } from "./alert-desk-cursor.ts";

describe("a drain pass", () => {
	describe("the first start: where the desk begins when no cursor is stored (startAt)", () => {
		test('startAt defaults to "end"; only "beginning" changes it', () => {
			expect(DEFAULTS.startAt).toBe("end");
			expect(parseConfig({}).startAt).toBe("end");
			expect(parseConfig({ startAt: "beginning" }).startAt).toBe("beginning");
			expect(parseConfig({ startAt: "middle" }).startAt).toBe("end");
		});
		test('"end" (the default) skips an existing inbox: no wake for earlier events, the choice logged once, later events wake', () => {
			const r = rig();
			r.writeConfig({ morningHour: 23, startAt: undefined });
			expect(readConfig(r.dir).startAt).toBe("end");
			writeFileSync(
				r.inbox,
				line({ at: T0 - 60_000 }) + line({ at: T0 - 30_000, family: "other", title: "other failed" }),
			);
			const size = statSync(r.inbox).size;
			expect(r.pass(T0)).toMatchObject({ read: 0, woke: 0 });
			expect(r.wakes()).toEqual([]);
			expect(r.store.state.get<Cursor>(CURSOR_KEY)).toMatchObject({ offset: size, inode: statSync(r.inbox).ino });
			expect(r.logged.filter((l) => l.event === "alert-desk-start")).toEqual([
				{ event: "alert-desk-start", startAt: "end", inbox: r.inbox, offset: size, skippedBytes: size },
			]);
			appendFileSync(r.inbox, line({ at: min(1), family: "third", title: "third failed" }));
			expect(r.pass(min(1)).read).toBe(1);
			expect(r.wakes()).toHaveLength(1);
			expect(r.logged.filter((l) => l.event === "alert-desk-start")).toHaveLength(1);
		});
		test('"end" with no inbox yet starts at its start, so the first lines written to it are read', () => {
			const r = rig();
			r.writeConfig({ morningHour: 23, startAt: "end" });
			expect(r.pass(T0).read).toBe(0);
			expect(r.logged.filter((l) => l.event === "alert-desk-start")).toEqual([
				{ event: "alert-desk-start", startAt: "end", inbox: r.inbox, offset: 0 },
			]);
			writeFileSync(r.inbox, line({ at: min(1) }));
			expect(r.pass(min(1)).read).toBe(1);
		});
		test('"beginning" reads the whole existing inbox, and logs that choice', () => {
			const r = rig();
			r.writeConfig({ morningHour: 23, startAt: "beginning" });
			writeFileSync(r.inbox, line({ at: T0 - 60_000 }));
			expect(r.pass(T0).read).toBe(1);
			expect(r.wakes()).toHaveLength(1);
			expect(r.logged.filter((l) => l.event === "alert-desk-start")).toEqual([
				{ event: "alert-desk-start", startAt: "beginning", inbox: r.inbox, offset: 0 },
			]);
		});
		test("a stored cursor is never moved by startAt", () => {
			const r = rig();
			writeFileSync(r.inbox, line({ at: T0 - 60_000 }));
			r.store.state.set(CURSOR_KEY, { offset: 0, inode: statSync(r.inbox).ino, retired: [] } satisfies Cursor);
			r.writeConfig({ morningHour: 23, startAt: "end" });
			expect(r.pass(T0).read).toBe(1);
			expect(r.logged.filter((l) => l.event === "alert-desk-start")).toEqual([]);
		});
	});

	test("alert-desk.json can turn the desk off", () => {
		const r = rig({ enabled: false });
		writeFileSync(r.inbox, line({ at: T0 - 60_000 }));
		expect(r.pass(T0)).toMatchObject({ skipped: "off" });
	});

	test("the cursor survives a restart (it is in the database), so only new lines are read", () => {
		const r = rig();
		writeFileSync(r.inbox, line({ at: T0 - 60_000 }));
		expect(r.pass(T0).read).toBe(1);
		expect(r.pass(T0 + 1000).read).toBe(0);
		appendFileSync(r.inbox, line({ at: T0 + 2000, family: "other", title: "o" }));
		expect(r.pass(T0 + 3000).read).toBe(1);
	});

	test("families nobody has reported for three days are resolved, so a later event is a new occurrence", () => {
		const r = rig();
		feed(r, [{}]);
		r.pass(T0 + 4 * DAY_MS);
		expect(r.store.items.get(ALERT_DESK, ev().family)?.status).toBe("resolved");
		appendFileSync(r.inbox, line({ at: T0 + 4 * DAY_MS }));
		r.pass(T0 + 4 * DAY_MS);
		expect(r.reasons().at(-1)).toBe("new");
	});

	describe("a crash at any step of a rotation or of reading a retired file loses no event", () => {
		const points: CrashPoint[] = ["rotation-intent", "renamed", "rotation-saved", "retired-read", "retired-saved"];
		const familyOf = (m: string) => /alert family (\S+)/.exec(m)?.[1];
		for (const point of points) {
			test(point, () => {
				const r = rig({ morningHour: 23, rotateBytes: 1024 });
				const big = "x".repeat(2000);
				appendFileSync(
					r.inbox,
					line({ at: T0 - 2000, family: "fa", title: "a", body: big }) +
						line({ at: T0 - 1000, family: "fb", title: "b", body: big }),
				);
				r.pass(T0);
				expect(r.messages().map(familyOf).sort()).toEqual(["fa", "fb"]);
				const rotatedAt = T0 + 60_000;
				let crashed = false;
				const crash = (p: CrashPoint) => {
					if (crashed || p !== point) return;
					crashed = true;
					if (p === "rotation-intent") appendFileSync(r.inbox, line({ at: rotatedAt, family: "fl", title: "l" }));
					if (p === "renamed" || p === "rotation-saved")
						appendFileSync(`${r.dir}/inbox.jsonl.${rotatedAt}`, line({ at: rotatedAt, family: "fl", title: "l" }));
					throw Error(`crash at ${p}`);
				};
				const pass = (now: number) => {
					try {
						r.pass(now, { crash });
					} catch (e) {
						if (!String(e).includes("crash at")) throw e;
					}
				};
				pass(rotatedAt);
				if (!["rotation-intent", "renamed", "rotation-saved"].includes(point))
					appendFileSync(`${r.dir}/inbox.jsonl.${rotatedAt}`, line({ at: rotatedAt, family: "fl", title: "l" }));
				appendFileSync(r.inbox, line({ at: rotatedAt + 1000, family: "fn", title: "n" }));
				for (const now of [T0 + 130_000, T0 + 200_000, T0 + 300_000, T0 + 400_000]) pass(now);
				expect(crashed).toBe(true);
				// Every event woke the desk exactly once: replays are absorbed by the items.
				expect(r.messages().map(familyOf).sort()).toEqual(["fa", "fb", "fl", "fn"]);
				expect(r.store.state.get<Cursor>(CURSOR_KEY)?.retired).toEqual([]);
				expect(r.store.state.get<Cursor>(CURSOR_KEY)?.rotating).toBeUndefined();
				r.pass(T0 + 20 * 60_000);
				expect(existsSync(`${r.dir}/inbox.jsonl.${rotatedAt}`)).toBe(false);
			});
		}
		test("a rotation with no crash does the same", () => {
			const r = rig({ morningHour: 23, rotateBytes: 1024 });
			appendFileSync(r.inbox, line({ at: T0 - 1000, family: "fa", title: "a", body: "x".repeat(2000) }));
			r.pass(T0);
			r.pass(T0 + 60_000);
			expect(existsSync(r.inbox)).toBe(false);
			expect(r.store.state.get<Cursor>(CURSOR_KEY)?.retired).toHaveLength(1);
			appendFileSync(r.inbox, line({ at: T0 + 70_000, family: "fn", title: "n" }));
			r.pass(T0 + 130_000);
			expect(r.messages().map((m) => /alert family (\S+)/.exec(m)?.[1])).toEqual(["fa", "fn"]);
			expect(r.store.state.get<Cursor>(CURSOR_KEY)?.retired).toEqual([]);
		});
	});

	describe("a retired file or inbox bigger than one chunk (4 MiB) is read to its end", () => {
		const bigLine = (i: number) =>
			line({ at: T0 - 100_000 + i, family: `f${i}`, title: `t${i}`, body: "y".repeat(1200) });
		const noCap = { morningHour: 23, dailyCap: 0, maxAgeHours: 48 };
		const familiesOf = (r: ReturnType<typeof rig>) =>
			new Set(
				r
					.messages()
					.map((m) => /alert family (\S+)/.exec(m)?.[1])
					.filter(Boolean),
			);
		const retire = (r: ReturnType<typeof rig>, body: string) => {
			const path = `${r.dir}/inbox.jsonl.${T0 - 600_000}`;
			writeFileSync(path, body);
			r.store.state.set(CURSOR_KEY, { offset: 0, inode: 0, retired: [{ path, offset: 0, after: 0 }] } satisfies Cursor);
			return path;
		};

		test("a retired file with a 5.9 MB tail wakes every family, and is deleted only after its last byte is read and saved", () => {
			const r = rig(noCap);
			const N = 4200;
			const retired = retire(r, Array.from({ length: N }, (_, i) => bigLine(i)).join(""));
			expect(statSync(retired).size).toBeGreaterThan(5 * 1024 * 1024);
			r.pass(T0);
			const afterOne = r.store.state.get<Cursor>(CURSOR_KEY)!;
			// One chunk is 4 MiB: part of the file was read, progress is recorded exactly up to it, and the file is neither finished nor deleted.
			expect(existsSync(retired)).toBe(true);
			expect(afterOne.retired).toHaveLength(1);
			expect(afterOne.retired[0]!.offset).toBeGreaterThan(3 * 1024 * 1024);
			expect(afterOne.retired[0]!.offset).toBeLessThanOrEqual(4 * 1024 * 1024);
			expect(afterOne.retired[0]!.offset).toBeLessThan(statSync(retired).size);
			const first = familiesOf(r).size;
			expect(first).toBeGreaterThan(2000);
			expect(first).toBeLessThan(N);
			r.pass(T0 + 60_000);
			expect(familiesOf(r).size).toBe(N);
			expect(existsSync(retired)).toBe(false);
			expect(r.store.state.get<Cursor>(CURSOR_KEY)?.retired).toEqual([]);
			expect(new Set(r.wakes()).size).toBe(N);
		});
		test("a crash after the first chunk was delivered but before it was saved reads it again, and wakes nobody twice", () => {
			const r = rig(noCap);
			const N = 3600;
			const retired = retire(r, Array.from({ length: N }, (_, i) => bigLine(i)).join(""));
			expect(() =>
				r.pass(T0, {
					crash: (p) => {
						if (p === "delivered") throw Error("crash");
					},
				}),
			).toThrow("crash");
			r.pass(T0 + 1000);
			r.pass(T0 + 61_000);
			expect(new Set(r.wakes()).size).toBe(N);
			expect(r.wakes()).toHaveLength(N);
			expect(existsSync(retired)).toBe(false);
		}, 60_000); // heavy by design (3600 large events, three passes): 5.6 s seen under load, so the 5 s default flakes
		test("a retired file that ends in a torn line is finished and deleted", () => {
			const r = rig(noCap);
			const retired = retire(r, `${line({ at: T0 - 1000, family: "fa", title: "a" })}{"v":1,"family":"torn`);
			r.pass(T0);
			expect(familiesOf(r)).toEqual(new Set(["fa"]));
			expect(existsSync(retired)).toBe(false);
		});
		test("a final line without its newline that is a whole event is read, not dropped", () => {
			const r = rig(noCap);
			const retired = retire(
				r,
				line({ at: T0 - 1000, family: "fa", title: "a" }) + line({ at: T0 - 500, family: "fb", title: "b" }).trimEnd(),
			);
			r.pass(T0);
			expect(familiesOf(r)).toEqual(new Set(["fa", "fb"]));
			expect(existsSync(retired)).toBe(false);
		});
		test("an event glued to the end of a line exactly one chunk long is part of that bad line, not an event", () => {
			const r = rig(noCap);
			writeFileSync(
				r.inbox,
				`${"x".repeat(4 * MIB)}${line({ at: T0 - 1000, family: "fa", title: "a" })}${line({ at: T0 - 900, family: "fb", title: "b" })}`,
			);
			r.pass(T0);
			r.pass(T0 + 1000);
			r.pass(T0 + 2000);
			expect(familiesOf(r)).toEqual(new Set(["fb"]));
		});
		test("a bad line longer than two chunks is skipped whole, and the event after it is read once", () => {
			const r = rig(noCap);
			writeFileSync(
				r.inbox,
				`${"x".repeat(9 * MIB)}${line({ at: T0 - 1000, family: "fa", title: "a" })}${line({ at: T0 - 900, family: "fb", title: "b" })}`,
			);
			for (let i = 0; i < 5; i++) r.pass(T0 + i * 1000);
			expect(familiesOf(r)).toEqual(new Set(["fb"]));
		});
		test("a retired file whose last line is the rest of a skipped line delivers nothing from it and is finished", () => {
			const r = rig(noCap);
			const retired = retire(r, `${"x".repeat(4 * MIB)}${line({ at: T0 - 1000, family: "fa", title: "a" }).trimEnd()}`);
			r.pass(T0);
			r.pass(T0 + 1000);
			expect(familiesOf(r)).toEqual(new Set());
			expect(existsSync(retired)).toBe(false);
		});
		test("the live inbox with a first line bigger than a chunk skips that line and goes on to the next", () => {
			const r = rig(noCap);
			writeFileSync(r.inbox, `${"x".repeat(4.5 * 1024 * 1024)}\n${line({ at: T0 - 1000, family: "fa", title: "a" })}`);
			r.pass(T0);
			r.pass(T0 + 1000);
			expect(familiesOf(r)).toEqual(new Set(["fa"]));
		});
	});
});
