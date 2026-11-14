/**
 * The contract of an optional module: a feature that lives in its own folder `src/modules/<name>/`, is OFF until its section of config.json
 * turns it on, keeps its own database file, and that core never imports. Chamberlain runs the same without it: a module that is off has
 * no timer, no tables, no wake kind and no page change.
 *
 * Core meets a module only through this type, as it meets a backend only through the adapter contract (src/core/adapter.ts). The one
 * registry that names the modules is src/modules/index.ts, and only the entry points (src/cli.ts, src/daemon.ts) import it;
 * src/architecture.test.ts reads every import and fails the build on a violation, so there is no shortcut to take by accident.
 * docs/ARCHITECTURE.md says how to add one.
 */
import type { Log } from "./log.ts";

export type ModuleContext = {
	/** The config directory and the state directory this process runs against. */
	conf: string;
	state: string;
	log: Log;
};

/** A module that has been started inside the daemon. */
export type RunningModule = { stop(): void };

export type Module = {
	/** The folder under src/modules/, the section of config.json and the command `chamberlain <name>`: one word for all three. */
	readonly name: string;
	/** Pure: whether the module's section (undefined when absent) turns it on. Throws on a section it does not understand. */
	enabled(section: unknown): boolean;
	/** Starts what the module runs inside the daemon. Called only when `enabled` said yes. */
	start(ctx: ModuleContext): RunningModule;
	/** `chamberlain <name> ...`. A module that is off says so, makes no file and exits 0. */
	main(argv: string[]): Promise<unknown>;
};
