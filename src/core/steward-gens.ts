/**
 * Steward generations: the current MAX(gen), seeding gen 1 from config, and resolving switch-owned secret refs.
 * Gen 0 is reserved (legacy, destination unknown) and has no row.
 */
import { mkdirSync } from "node:fs";
import { ensureSecretsDir, secretPath, thread } from "./layout.ts";
import type { StewardGen } from "./steward-types.ts";
import type { Store } from "./store.ts";

const STEWARD_SECRETS = "steward";

/** Ensures `secrets/steward/` exists at mode 0700. */
export function ensureStewardSecretsDir(conf: string): string {
	const dir = `${ensureSecretsDir(conf)}/${STEWARD_SECRETS}`;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** Absolute path of a switch-owned ref: `secrets/steward/<id>.wake` or `.compact`. */
export const switchRefPath = (conf: string, switchId: string, kind: "wake" | "compact"): string =>
	`${ensureSecretsDir(conf)}/${STEWARD_SECRETS}/${switchId}.${kind}`;

/** Relative ref stored in steward_gens (under secrets/). */
export const switchRefName = (switchId: string, kind: "wake" | "compact"): string =>
	`${STEWARD_SECRETS}/${switchId}.${kind}`;

/** The current generation, or undefined before seeding. */
export const currentGen = (store: Store): StewardGen | undefined => store.steward.current();

/** MAX(gen), or 0 when none. */
export const maxGen = (store: Store): number => store.steward.maxGen();

/**
 * Seeds gen 1 from `threads.steward` and the shared wake-url / compact-url names when they exist.
 * Idempotent: does nothing when any generation row already exists.
 */
export function seedGen1(store: Store, conf: string, now = Date.now()): StewardGen | undefined {
	if (store.steward.maxGen() > 0) return store.steward.current();
	const stewardThread = thread(conf, "steward");
	if (!stewardThread) return undefined;
	const wake = secretPath(conf, "wake-url");
	if (!wake) return undefined;
	const compact = secretPath(conf, "compact-url");
	const g: StewardGen = {
		gen: 1,
		thread: stewardThread,
		wakeRef: "wake-url",
		...(compact ? { compactRef: "compact-url" } : {}),
		createdAt: now,
	};
	store.tx(() => store.steward.insertGen(g));
	return g;
}
