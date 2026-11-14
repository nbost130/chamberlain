/**
 * `mail.db`'s schema, as versioned SQL migrations: its own numbered sequence in its own file, never `chamberlain.db`'s (docs/EMAIL-TRIAGE.md,
 * section 2). Each is applied once, in order, inside one transaction, and recorded in `mail.db`'s `migrations` table; a migration is never
 * edited after a release, a change is a new entry. A database with a newer migration than the last one here was written by a newer build
 * and is refused (src/modules/mail/db.ts).
 *
 * What is kept is metadata and bounded derived text, never a mail body (section 8): every text column that holds anything derived from a
 * mail carries a length CHECK, and no column is named or sized for a body. src/modules/mail/db.test.ts holds both. The tables the later
 * pieces own are added by their own migrations: rules (B3, #36), cards, actions and the unattended-archive state (B5, #38), highlights
 * and labelled examples (B7, #40).
 */
import type { Migration } from "../../core/migrations.ts";

export const MAIL_MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		name: "initial schema",
		sql: `
-- Small facts the module keeps between runs: the mailbox cursor, a pause. A key and a short value, nothing from a mail.
CREATE TABLE mail_state (
	key TEXT PRIMARY KEY CHECK (length(key) <= 64),
	value TEXT NOT NULL CHECK (length(value) <= 1000),
	updated_at INTEGER NOT NULL
);

-- One row per message the module has triaged: ids, the sender's address, list id, date, category, what became of it, by which rule and
-- tier, and what the model calls cost. Kept 90 days; the subject is cut to 120 characters and set to NULL after 30 (section 8).
CREATE TABLE mail_messages (
	id INTEGER PRIMARY KEY,
	provider_id TEXT NOT NULL UNIQUE CHECK (length(provider_id) <= 200),
	thread_id TEXT CHECK (thread_id IS NULL OR length(thread_id) <= 200),
	from_address TEXT CHECK (from_address IS NULL OR length(from_address) <= 320),
	list_id TEXT CHECK (list_id IS NULL OR length(list_id) <= 320),
	subject TEXT CHECK (subject IS NULL OR length(subject) <= 120),
	date INTEGER,
	category TEXT CHECK (category IS NULL OR length(category) <= 64),
	outcome TEXT NOT NULL CHECK (length(outcome) <= 32),
	rule_id INTEGER,
	tier TEXT CHECK (tier IS NULL OR length(tier) <= 32),
	input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
	output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
	triaged_at INTEGER NOT NULL
);
CREATE INDEX mail_messages_by_triaged_at ON mail_messages (triaged_at);
`,
	},
];

export const LATEST_MAIL_MIGRATION = MAIL_MIGRATIONS[MAIL_MIGRATIONS.length - 1]?.version ?? 0;
