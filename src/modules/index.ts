/**
 * The module registry: the one file that names more than one module. A new module is one new folder under src/modules/ and one line here,
 * as a new backend is one folder under src/adapters/ and one line in src/adapters/index.ts. A module imports src/core/ and its own folder,
 * never an adapter and never another module, and nothing in src/core/ imports this file: src/architecture.test.ts holds all three.
 *
 * Only the entry points read it (src/cli.ts and src/daemon.ts). A module whose section is absent is not in `activeModules`, so it starts
 * nothing: no timer, no file, no event.
 */

import { cfg } from "../core/layout.ts";
import type { Module, ModuleContext, RunningModule } from "../core/module.ts";
import { mail } from "./mail/index.ts";

export const MODULES: readonly Module[] = [mail];

/** The modules whose section of `conf`'s config.json turns them on. A section a module cannot parse throws, naming it. */
export function activeModules(conf: string, modules: readonly Module[] = MODULES): Module[] {
	return modules.filter((m) => m.enabled(cfg(conf, m.name)));
}

/** Starts every active module; the daemon calls this once and stops what it returns when it shuts down. */
export function startModules(ctx: ModuleContext, modules: readonly Module[] = MODULES): RunningModule {
	const running = activeModules(ctx.conf, modules).map((m) => m.start(ctx));
	return {
		stop: () => {
			for (const r of running) r.stop();
		},
	};
}

/** Runs `chamberlain <name> ...` for a module, whether it is on or off (an off module says so). */
export async function moduleMain(name: string, argv: string[], modules: readonly Module[] = MODULES): Promise<unknown> {
	const m = modules.find((x) => x.name === name);
	if (!m) throw Error(`no module named "${name}"`);
	return m.main(argv);
}
