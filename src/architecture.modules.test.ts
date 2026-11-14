/** architecture, continued: the optional-module rules. See architecture.test.ts for the overview. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	files,
	importsOf,
	MAY_SPAWN,
	moduleReachViolations,
	moduleViolations,
	REGISTRY,
	SRC,
	walk,
} from "./architecture-boundary-scans.test.ts";

describe("optional modules", () => {
	// This file is not scanned: its scanner self-tests hold import statements as strings.
	const all = () => walk(SRC).filter((f) => !/^architecture([.-][a-z-]+)?\.test\.ts$/.test(f));

	test("the scan is not vacuous: the mail module and the registry exist", () => {
		expect(files("modules")).toContain("modules/index.ts");
		expect(files("modules").filter((f) => f.startsWith("modules/mail/")).length).toBeGreaterThan(3);
	});

	test("nothing in src/core/ imports src/modules/", () => {
		const bad = files("core").flatMap((f) => moduleViolations(f, readFileSync(join(SRC, f), "utf8")));
		expect(bad).toEqual([]);
	});

	test("a module imports only core and itself, never an adapter, another module or the registry, and never bun:sqlite", () => {
		const bad = files("modules")
			.filter((f) => f !== REGISTRY && !f.endsWith("index.test.ts") && !f.endsWith("daemon.test.ts"))
			.flatMap((f) => moduleViolations(f, readFileSync(join(SRC, f), "utf8")));
		expect(bad).toEqual([]);
	});

	test("only cli.ts, daemon.ts and the registry name src/modules/ outside it (a test outside core may drive the registry)", () => {
		const bad = all().flatMap((f) => moduleViolations(f, readFileSync(join(SRC, f), "utf8")));
		expect(bad).toEqual([]);
		const importers = all().filter((f) => importsOf(readFileSync(join(SRC, f), "utf8"), f).includes(REGISTRY));
		expect(importers.filter((f) => !f.endsWith(".test.ts")).sort()).toEqual(["cli.ts", "daemon.ts"]);
	});

	test("no file under src/modules/ has a network client or spawns a process it is not listed for", () => {
		const bad = files("modules").flatMap((f) => moduleReachViolations(f, readFileSync(join(SRC, f), "utf8")));
		expect(bad).toEqual([]);
		expect(Object.keys(MAY_SPAWN).filter((f) => !files("modules").includes(f))).toEqual([]);
	});

	test("the reach scanner catches each way to reach out (so a pass means something)", () => {
		const f = "modules/mail/x.ts";
		for (const code of [
			'const r = await fetch("https://example.com");',
			'const r = await fetch ("https://example.com");',
			'import https from "node:https";',
			'import { connect } from "net";',
			'import { request } from "undici";',
			'const s = new WebSocket("wss://x");',
			"const s = Bun.listen({});",
			"const p = Bun.spawn(['ls']);",
			"const p = Bun.spawnSync(['ls']);",
			"const p = Bun.$`ls`;",
			// Bun's own exports and every way to hold the global: none is a literal `Bun.spawn` or `Bun.$`.
			'import { $ } from "bun";\nexport const child = () => $`/usr/bin/true`;',
			'import { $ as sh } from "bun";\nexport const child = () => sh`/usr/bin/true`;',
			'import { spawn } from "bun";\nspawn(["ls"]);',
			'import * as bun from "bun";\nbun.spawnSync(["ls"]);',
			'import bun from "bun";\nbun.$`ls`;',
			'const { $ } = await import("bun");',
			'const { spawn } = require("bun");',
			"const { spawn } = Bun;",
			"const B = Bun;\nB.spawn(['ls']);",
			"Bun?.spawn(['ls']);",
			'Bun["spawn"](["ls"]);',
			"globalThis.Bun.spawn(['ls']);",
			'import { dlopen } from "bun:ffi";',
			'import { execa } from "execa";',
			'import cp from "cross-spawn";',
			'import { fork } from "node:cluster";',
			'import { exec } from "child_process";',
			'import { exec } from "node:child_process";',
			'const m = require("node:http");',
			'const m = await import("node:dns", {});',
		])
			expect(moduleReachViolations(f, code), code).not.toEqual([]);
		// What is allowed: the same words in comments, tests and strings of another shape, and other files that are not modules.
		expect(moduleReachViolations(f, "// await fetch(url) is not allowed here\nconst a = 1;")).toEqual([]);
		expect(moduleReachViolations("modules/mail/x.test.ts", "Bun.spawn(['bun']); await fetch(u);")).toEqual([]);
		expect(moduleReachViolations("core/x.ts", "Bun.spawn(['ls']);")).toEqual([]);
		expect(moduleReachViolations(f, 'import { join } from "node:path";\nconst s = "fetched";')).toEqual([]);
		// The Bun members that are files, time and hashing are not process or network capabilities.
		expect(
			moduleReachViolations(f, "await Bun.write(p, await Bun.file(q).text()); await Bun.sleep(1); Bun.hash(s);"),
		).toEqual([]);
	});

	test("the scanner catches each kind of violation (so a pass means something)", () => {
		expect(moduleViolations("core/x.ts", 'import { a } from "../modules/mail/db.ts";')).toHaveLength(1);
		// The spellings a plain relative static import hides behind: a space before the parenthesis, import options, require, and an absolute path or file URL.
		for (const code of [
			'await import ("../modules/mail/db.ts");',
			'await import("../modules/mail/db.ts", {});',
			'const m = require("../modules/mail/db.ts");',
			'export * from "file://" + "x";\nexport * from "file://%SRC%/modules/mail/db.ts";',
			'import { a } from "%SRC%/modules/mail/db.ts";',
		])
			expect(moduleViolations("core/x.ts", code.replaceAll("%SRC%", SRC)), code).not.toEqual([]);
		expect(moduleViolations("core/x.ts", 'import { a } from "../modules/index.ts";')).toHaveLength(1);
		expect(moduleViolations("core/x.test.ts", 'import { a } from "../modules/index.ts";')).toHaveLength(1);
		expect(moduleViolations("core/x.ts", 'const m = await import("../modules/mail/cli.ts");')).toHaveLength(1);
		expect(moduleViolations("adapters/t3/x.ts", 'import { a } from "../../modules/mail/db.ts";')).toHaveLength(1);
		expect(moduleViolations("web/app.ts", 'import { a } from "../modules/index.ts";')).toHaveLength(1);
		expect(moduleViolations("ask.ts", 'import { a } from "./modules/mail/config.ts";')).toHaveLength(1);
		expect(moduleViolations("modules/mail/x.ts", 'import { a } from "../../adapters/t3/state.ts";')).toHaveLength(1);
		expect(moduleViolations("modules/mail/x.ts", 'import { a } from "../other/y.ts";')).toHaveLength(1);
		expect(moduleViolations("modules/mail/x.ts", 'import { a } from "../index.ts";')).toHaveLength(1);
		expect(moduleViolations("modules/mail/x.ts", 'import { Database } from "bun:sqlite";')).toHaveLength(1);
		// A test may read a database file raw, to check what the shared opener made.
		expect(moduleViolations("modules/mail/x.test.ts", 'import { Database } from "bun:sqlite";')).toEqual([]);
		// What is allowed.
		expect(moduleViolations("cli.ts", 'const m = await import("./modules/index.ts");')).toEqual([]);
		expect(moduleViolations("daemon.ts", 'import { a } from "./modules/index.ts";')).toEqual([]);
		expect(moduleViolations("cli.test.ts", 'import { a } from "./modules/index.ts";')).toEqual([]);
		expect(
			moduleViolations(
				"modules/mail/x.ts",
				'import { a } from "../../core/config.ts";\nimport { b } from "./db.ts";\n// import { c } from "../../adapters/t3/state.ts";',
			),
		).toEqual([]);
		expect(
			moduleViolations(
				"modules/index.ts",
				'import { mail } from "./mail/index.ts";\nimport { other } from "./other/index.ts";',
			),
		).toEqual([]);
		expect(moduleViolations("core/x.ts", 'import { a } from "./adapter.ts";')).toEqual([]);
	});
});
