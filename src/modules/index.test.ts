/**
 * The registry, and what "off means absent" is made of: a module whose section is absent (or "provider": "none") is not active, so starting
 * the modules makes no file, runs no timer and writes no event; one that is on is started once and made its file.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Module } from "../core/module.ts";
import { activeModules, MODULES, moduleMain, startModules } from "./index.ts";
import { mailDbPath } from "./mail/db.ts";

const dirs = () => {
	const root = mkdtempSync(join(tmpdir(), "modules-"));
	const conf = join(root, "conf"),
		state = join(root, "state");
	mkdirSync(conf, { mode: 0o700 });
	mkdirSync(state, { mode: 0o700 });
	return { conf, state };
};
const configure = (conf: string, doc: object) =>
	writeFileSync(join(conf, "config.json"), JSON.stringify(doc), { mode: 0o600 });
const ON = { provider: "gog", allowMailToLeaveMachine: true };

const stops: (() => void)[] = [];
afterEach(() => {
	for (const s of stops.splice(0)) s();
});

describe("the registry", () => {
	test("it holds the mail module, and the module's name is its folder, its config section and its command", () => {
		expect(MODULES.map((m) => m.name)).toEqual(["mail"]);
	});

	test("a module is active only when its section turns it on", () => {
		const a = dirs();
		expect(activeModules(a.conf)).toEqual([]);
		configure(a.conf, {});
		expect(activeModules(a.conf)).toEqual([]);
		configure(a.conf, { mail: { provider: "none" } });
		expect(activeModules(a.conf)).toEqual([]);
		configure(a.conf, { mail: ON });
		expect(activeModules(a.conf).map((m) => m.name)).toEqual(["mail"]);
	});

	test("a section it cannot parse stops the start, naming the key, rather than quietly running with defaults", () => {
		const a = dirs();
		configure(a.conf, { mail: { provider: "gog", allowMailToLeaveMachine: true, colour: "blue" } });
		expect(() => activeModules(a.conf)).toThrow('mail: unknown key "colour"');
		configure(a.conf, { mail: { provider: "gog" } });
		expect(() => activeModules(a.conf)).toThrow("allowMailToLeaveMachine");
	});

	test("it is generic: another module is one more entry, started and stopped with the rest, and the mail module stays off", () => {
		const a = dirs();
		const started: string[] = [];
		const other: Module = {
			name: "other",
			enabled: () => true,
			start: () => {
				started.push("other");
				return { stop: () => started.push("stopped") };
			},
			main: async () => {},
		};
		const running = startModules({ conf: a.conf, state: a.state, log: () => {} }, [...MODULES, other]);
		expect(started).toEqual(["other"]);
		expect(existsSync(mailDbPath(a.state))).toBe(false);
		running.stop();
		expect(started).toEqual(["other", "stopped"]);
	});

	test("moduleMain names a module, and refuses one that is not there", async () => {
		await expect(moduleMain("nothing", [])).rejects.toThrow('no module named "nothing"');
	});
});

describe("off means absent", () => {
	test("with mail absent, starting the modules makes no mail.db, writes no event and leaves the state directory empty", () => {
		const a = dirs();
		const events: string[] = [];
		const running = startModules({ conf: a.conf, state: a.state, log: (e) => events.push(e) });
		running.stop();
		expect(events).toEqual([]);
		expect(existsSync(mailDbPath(a.state))).toBe(false);
		expect(readdirSync(a.state)).toEqual([]);
	});

	test('with "provider": "none" it is the same', () => {
		const a = dirs();
		configure(a.conf, { mail: { provider: "none", mode: "live", allowMailToLeaveMachine: true } });
		const events: string[] = [];
		startModules({ conf: a.conf, state: a.state, log: (e) => events.push(e) }).stop();
		expect(events).toEqual([]);
		expect(readdirSync(a.state)).toEqual([]);
	});

	test("starting the modules sets no timer, off or (until B8 adds the schedule) on", () => {
		const timers: string[] = [];
		const real = { timeout: globalThis.setTimeout, interval: globalThis.setInterval };
		globalThis.setTimeout = ((...a: Parameters<typeof setTimeout>) => {
			timers.push("setTimeout");
			return real.timeout(...a);
		}) as typeof setTimeout;
		globalThis.setInterval = ((...a: Parameters<typeof setInterval>) => {
			timers.push("setInterval");
			return real.interval(...a);
		}) as typeof setInterval;
		try {
			const off = dirs();
			startModules({ conf: off.conf, state: off.state, log: () => {} }).stop();
			const on = dirs();
			configure(on.conf, { mail: ON });
			startModules({ conf: on.conf, state: on.state, log: () => {} }).stop();
		} finally {
			globalThis.setTimeout = real.timeout;
			globalThis.setInterval = real.interval;
		}
		expect(timers).toEqual([]);
	});

	test("starting and stopping the modules, off or on, starts no process, whatever it is called or however short it lives", () => {
		// The spies stand at the call, before anything runs, so a process that began and ended inside it (and a name no test knows) still shows.
		const started: string[] = [];
		const real = { spawn: Bun.spawn, spawnSync: Bun.spawnSync };
		Bun.spawn = ((...a: unknown[]) => {
			started.push(`Bun.spawn ${JSON.stringify(a[0])}`);
			return (real.spawn as (...x: unknown[]) => unknown)(...a);
		}) as typeof Bun.spawn;
		Bun.spawnSync = ((...a: unknown[]) => {
			started.push(`Bun.spawnSync ${JSON.stringify(a[0])}`);
			return (real.spawnSync as (...x: unknown[]) => unknown)(...a);
		}) as typeof Bun.spawnSync;
		try {
			const off = dirs();
			startModules({ conf: off.conf, state: off.state, log: () => {} }).stop();
			const on = dirs();
			configure(on.conf, { mail: ON });
			startModules({ conf: on.conf, state: on.state, log: () => {} }).stop();
		} finally {
			Bun.spawn = real.spawn;
			Bun.spawnSync = real.spawnSync;
		}
		expect(started).toEqual([]);
	});

	test("with the module on, the first start makes mail.db and says so once; stopping closes it", () => {
		const a = dirs();
		configure(a.conf, { mail: ON });
		const events: [string, unknown][] = [];
		const running = startModules({ conf: a.conf, state: a.state, log: (e, d) => events.push([e, d]) });
		stops.push(() => running.stop());
		expect(existsSync(mailDbPath(a.state))).toBe(true);
		expect(events).toEqual([["mail.start", { schema: 1 }]]);
		running.stop();
		stops.pop();
	});
});
