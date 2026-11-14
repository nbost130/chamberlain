/** What every part of the SQLite store shares: a row, the JSON helpers and the database handle the make* functions work through. */

export type Row = Record<string, unknown>;
export const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));
export const parse = <T>(s: unknown): T | undefined => (typeof s === "string" ? (JSON.parse(s) as T) : undefined);
export const mergeInto = (base: Record<string, unknown>, patch: Record<string, unknown>) => ({ ...base, ...patch });

/** A row a query cannot fail to return (an aggregate, the sequence row a migration creates, a row just written): its absence is a broken database. */
export function required(r: Row | undefined, what: string): Row {
	if (!r) throw Error(`the database has no ${what}`);
	return r;
}

/** One database and what every part of the store needs from it: the transaction wrapper and three query helpers. */
export type Db = {
	tx<T>(fn: () => T): T;
	all(sql: string, ...p: unknown[]): Row[];
	one(sql: string, ...p: unknown[]): Row | undefined;
	run(sql: string, ...p: unknown[]): { changes: number; lastInsertRowid: number | bigint };
	/** Runs `fn` with the busy timeout at zero, so a held write lock is an error at once and not a wait of seconds. */
	nowait<T>(fn: () => T): T;
};
