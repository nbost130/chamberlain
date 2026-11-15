/**
 * Steward generations: the current MAX(gen), seeding gen 1 from config, and resolving switch-owned secret refs.
 * Gen 0 is reserved (legacy, destination unknown) and has no row.
 */
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	mkdirSync,
	openSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { ensureSecretsDir, readNamed, secretPath, thread } from "./layout.ts";
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

/** One-generation snapshot for rights, CAS and transport (design §2.2 / B1). */
export type GenSnapshot = {
	gen: number;
	thread: string;
	wakeRef: string;
	compactRef?: string;
	/** Resolved wake URL at sample time; POST must use this, not a later re-read. */
	wakeUrl?: string;
};

/** Read MAX(gen) once, with its immutable refs and resolved wake URL. */
export function snapshotGen(store: Store, conf?: string): GenSnapshot | undefined {
	const g = store.steward.current();
	if (!g) return undefined;
	return {
		gen: g.gen,
		thread: g.thread,
		wakeRef: g.wakeRef,
		...(g.compactRef ? { compactRef: g.compactRef } : {}),
		...(conf ? { wakeUrl: readNamed(conf, g.wakeRef) } : {}),
	};
}

/**
 * Publish a switch-owned ref: write temp (0600) + fsync, link (never overwrite), fsync directory, unlink temp.
 * Returns false when the final path already exists.
 */
export function publishSwitchRef(conf: string, switchId: string, kind: "wake" | "compact", body: string): boolean {
	const final = switchRefPath(conf, switchId, kind);
	mkdirSync(dirname(final), { recursive: true, mode: 0o700 });
	if (existsSync(final)) return false;
	const tmp = `${final}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeSync(fd, body);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	chmodSync(tmp, 0o600);
	try {
		linkSync(tmp, final);
	} catch {
		unlinkSync(tmp);
		return false;
	}
	try {
		const dirFd = openSync(dirname(final), "r");
		try {
			fsyncSync(dirFd);
		} finally {
			closeSync(dirFd);
		}
	} catch {
		// best-effort directory sync
	}
	unlinkSync(tmp);
	return true;
}

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
