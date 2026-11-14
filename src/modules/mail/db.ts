/**
 * `mail.db`: the email triage module's own database, beside `chamberlain.db` in the state directory. Opened by the same code as
 * `chamberlain.db` (src/core/database.ts: private, WAL, its own migrations), so a database from a newer build is refused with the same
 * words, and the file is made only when the module is on: nothing here runs while `mail` is off.
 */
import { join } from "node:path";
import { type Db, type OpenOptions, openDatabase, queries } from "../../core/database.ts";
import { SchemaTooNewError } from "../../core/schema.ts";
import { LATEST_MAIL_MIGRATION, MAIL_MIGRATIONS } from "./migrations.ts";

export const MAIL_DB_FILE = "mail.db";
export const mailDbPath = (state: string): string => join(state, MAIL_DB_FILE);

/** `mail.db` was written by a newer Chamberlain than this build. */
export class MailDatabaseTooNewError extends SchemaTooNewError {
	constructor(path: string, found: number) {
		super(`the database ${path}`, found, LATEST_MAIL_MIGRATION, "migration");
		this.name = "MailDatabaseTooNewError";
	}
}

export type MailDb = Db & { readonly path: string; close(): void };

/** Opens (creating and migrating) `<state>/mail.db`. Called only with the module on. */
export function openMailDb(state: string, o: OpenOptions = {}): MailDb {
	const path = mailDbPath(state);
	const db = openDatabase(path, o, {
		migrations: MAIL_MIGRATIONS,
		tooNew: (p, found) => new MailDatabaseTooNewError(p, found),
	});
	return { ...queries(db), path, close: () => db.close() };
}
