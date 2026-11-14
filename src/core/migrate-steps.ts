/** The stored files, their migration steps, and upgrading one record through them. */
import { existsSync } from "node:fs";
import { oldFileState } from "./layout-legacy.ts";
import { SCHEMA_VERSION, versionOf } from "./schema.ts";

/** json: one document. jsonl: one record per line. servers: servers.json. */
export type Kind = "json" | "jsonl" | "servers";
type Step = (data: unknown) => unknown;
type Dir = "conf" | "state";
export type StoredFile = { dir: Dir; name: string; kind: Kind };

/** Every versioned config file. */
export const FILES: StoredFile[] = [
	{ dir: "conf", name: "settings.json", kind: "json" },
	{ dir: "conf", name: "web.json", kind: "json" },
	{ dir: "conf", name: "sweep.json", kind: "json" },
	{ dir: "conf", name: "servers.json", kind: "servers" },
];

const stampStep: Step = (d) => (d && typeof d === "object" && !Array.isArray(d) ? { schemaVersion: 1, ...d } : d);
/** 1 -> 2 changed no shape for this kind: upgradeData stamps the new version. */
const sameShape: Step = (d) => d;

export const STEPS: Record<Kind, Step[]> = {
	json: [stampStep, sameShape],
	jsonl: [stampStep, sameShape],
	servers: [
		stampStep,
		// 1 -> 2: every entry names its adapter. Every server was T3 Code before adapters existed.
		(d) =>
			d && typeof d === "object" && Array.isArray((d as { servers?: unknown }).servers)
				? {
						...d,
						servers: (d as { servers: Record<string, unknown>[] }).servers.map((x) => ({
							...x,
							adapter: x.adapter ?? "t3",
						})),
					}
				: d,
	],
};

/** Pure: a record upgraded from `from` through every step to `to`. A version with no step is an error, never a skip. */
export function upgradeData(
	kind: Kind,
	data: unknown,
	from: number,
	{ to = SCHEMA_VERSION, steps = STEPS }: { to?: number; steps?: Record<Kind, Step[]> } = {},
): unknown {
	let d = data;
	for (let v = from; v < to; v++) {
		const step = steps[kind][v];
		if (!step) throw Error(`no migration for ${kind} from schemaVersion ${v}`);
		d = step(d);
		if (d && typeof d === "object" && !Array.isArray(d)) d = { ...(d as object), schemaVersion: v + 1 };
	}
	return d;
}

/** The version a parsed file or record claims; a file with no `schemaVersion` is version 0. */
export const versionOfData = (_kind: Kind, what: string, d: unknown): number => {
	const o = (d && typeof d === "object" ? d : {}) as { schemaVersion?: unknown };
	return versionOf(what, o.schemaVersion);
};

const pathOf = (f: StoredFile, conf: string, state: string) => `${f.dir === "conf" ? conf : state}/${f.name}`;

export type Entry = { path: string; what: string; kind: Kind };
export function entries(conf: string, state: string): Entry[] {
	return FILES.filter(
		// a file the layout migration moved is not read again by its old name: a rewritten one is not this build's to check or upgrade
		(f) => f.dir !== "conf" || oldFileState(conf, f.name, false) !== "reappeared",
	)
		.map((f) => ({ path: pathOf(f, conf, state), what: f.name, kind: f.kind }))
		.filter((e) => existsSync(e.path));
}
