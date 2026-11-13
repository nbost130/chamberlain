/**
 * The on-disk schema version. Every file Chamberlain keeps (JSON documents, and each line of a JSONL ledger) carries a
 * `schemaVersion` integer. This build writes SCHEMA_VERSION. A file without the field is from before versioning
 * (legacy-wake) and counts as version 0: src/core/migrate.ts upgrades it. A file with a NEWER version was written by a newer
 * Chamberlain, and this build refuses to read it rather than guess.
 */
export const SCHEMA_VERSION = 2;
/*
 * History: 1 stamped every file (it was unversioned in legacy-wake, so version 0). 2 gave each servers.json entry an `adapter`
 * (every server was T3 Code before adapters existed); no other file changed shape, so they are only re-stamped.
 */

export class SchemaTooNewError extends Error {
	constructor(readonly what: string, readonly found: number, readonly supported: number = SCHEMA_VERSION, unit = "schemaVersion") {
		super(`${what} has ${unit} ${found}, but this Chamberlain understands up to ${supported}. It was written by a newer Chamberlain: upgrade this install (or restore the file from a backup). Refusing to read or write it.`);
		this.name = "SchemaTooNewError";
	}
}

/** The version a parsed record claims: a missing field is 0 (unversioned). Throws for a newer, negative or non-integer one. */
export function versionOf(what: string, found: unknown): number {
	if (found === undefined) return 0;
	if (typeof found !== "number" || !Number.isInteger(found) || found < 0) throw Error(`${what}: schemaVersion must be a non-negative integer, got ${JSON.stringify(found)}`);
	return found;
}

/** Like versionOf, and refuses a newer version with SchemaTooNewError. */
export function checkVersion(what: string, found: unknown): number {
	const v = versionOf(what, found);
	if (v > SCHEMA_VERSION) throw new SchemaTooNewError(what, v);
	return v;
}

/** A record with the current version written first. */
export const stamp = <T extends object>(o: T): T & { schemaVersion: number } => ({ schemaVersion: SCHEMA_VERSION, ...o });
