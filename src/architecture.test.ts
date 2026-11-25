/**
 * The layering rules, enforced by reading every import statement:
 *
 *   - src/core/ never imports from src/adapters/. Core is backend-agnostic; it talks to a backend only through the
 *     Adapter contract (src/core/adapter/adapter.ts). Tests in core count: a core test builds its backend with src/testing/.
 *   - An adapter's folder imports only core and itself, never another adapter's folder. Only src/adapters/index.ts
 *     (the registry) names more than one.
 *   - The page's modules (src/web/) work through the contract too. Only its entry point, src/web/server.ts, wires the
 *     registry, and the tests may use an adapter to drive the page against a real backend's shapes.
 *
 * Imports are read from the source with comments removed, type-only imports included: a layering break is a break whether
 * or not the import survives compilation.
 *
 * The same file holds the second rule: there is ONE item system. Tracking a thing, de-duplicating it and re-notifying about it
 * all go through the items table, whose notification columns only `ItemStore.observe` writes, and whose one decision is
 * `decideNotification` (src/core/items/notification.ts). The tests below fail if a second dedup or re-notification mechanism appears:
 * one of the old identifiers (a sticky or seedable flag, a seen list, a fired file, an in-memory notification clock, or the
 * names the mechanism had before docs/GLOSSARY.md renamed it), another module writing the notification columns, or another
 * module deciding that a notification is due. The scan walks every .ts file under src/ recursively, so a new entry point is scanned the
 * day it is added. A spelling scan finds only what it knows to look for, so the guarantee's real test is behavioural: src/invariants.test.ts
 * (a second process, or a restart, over the same database file). docs/ARCHITECTURE.md says where the guarantee stops.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { files, SRC, violations } from "./architecture-boundary-scans.test.ts";

describe("the import boundary", () => {
	test("core Steward metering, health and context policy name no provider driver", () => {
		const violations = files("core")
			.filter(
				(f) =>
					f.startsWith("core/steward/steward-") ||
					/\/(?:engine-(?:steward|core-steward|context-guard)|context-guard|adapter-inspect|steward-meter|sqlite-usage|store-records)\.ts$/.test(
						f,
					) ||
					/^core\/overhead\/(?:brief|collect|metrics|prices)\.ts$/.test(f),
			)
			.filter(
				(f) =>
					!f.endsWith(".test.ts") &&
					/(?:claude(?:Agent)?|anthropic|codex|openai|cursor|antigravity|grok|xai|gemini)/i.test(
						readFileSync(join(SRC, f), "utf8"),
					),
			);
		expect(violations).toEqual([]);
	});
	test("src/core/ has files, so the scan below is not vacuous", () => {
		expect(files("core").length).toBeGreaterThan(20);
		expect(files("adapters").length).toBeGreaterThan(10);
	});

	test("nothing in src/core/ imports from src/adapters/", () => {
		const bad = files("core").flatMap((f) =>
			violations(f, readFileSync(join(SRC, f), "utf8")).filter((v) => v.includes("core must not")),
		);
		expect(bad).toEqual([]);
	});

	test("an adapter imports only core and itself, and the page's modules only the contract", () => {
		const all = [...files("adapters"), ...files("web")];
		const bad = all.flatMap((f) =>
			violations(f, readFileSync(join(SRC, f), "utf8")).filter((v) => !v.includes("core must not")),
		);
		expect(bad).toEqual([]);
	});

	test("the scanner catches each kind of violation (so a pass means something)", () => {
		expect(violations("core/x.ts", 'import { a } from "../adapters/t3/rpc.ts";')).toHaveLength(1);
		expect(violations("core/x.ts", 'export { a } from "../adapters/index.ts";')).toHaveLength(1);
		expect(violations("core/x.ts", 'const m = await import("../adapters/t3/state.ts");')).toHaveLength(1);
		expect(violations("core/x.test.ts", 'import type { T } from "../adapters/fake/index.ts";')).toHaveLength(1);
		expect(violations("core/x.ts", 'import {\n\ta,\n\tb,\n} from "../adapters/t3/state.ts";')).toHaveLength(1);
		expect(violations("core/x.ts", 'import "../adapters/t3/side-effect.ts";')).toHaveLength(1);
		expect(violations("core/x.ts", 'export type * from "../adapters/t3/state.ts";')).toHaveLength(1);
		expect(violations("adapters/t3/x.ts", 'import { a } from "../fake/index.ts";')).toHaveLength(1);
		expect(violations("adapters/t3/x.ts", 'import { a } from "../index.ts";')).toHaveLength(1);
		expect(violations("web/app.ts", 'import { a } from "../adapters/t3/state.ts";')).toHaveLength(1);
		// What is allowed.
		expect(
			violations(
				"core/x.ts",
				'import { a } from "./adapter.ts";\n// import { b } from "../adapters/t3/rpc.ts";\nconst s = \'from "../adapters/x"\';',
			),
		).toEqual([]);
		expect(
			violations("adapters/t3/x.ts", 'import { a } from "../../core/adapter.ts";\nimport { b } from "./rpc.ts";'),
		).toEqual([]);
		expect(violations("web/server.ts", 'import { a } from "../adapters/index.ts";')).toEqual([]);
		expect(violations("web/waiting.test.ts", 'import { a } from "../adapters/fake/index.ts";')).toEqual([]);
		expect(
			violations("adapters/index.ts", 'import { a } from "./t3/index.ts";\nimport { b } from "./fake/index.ts";'),
		).toEqual([]);
	});
});
