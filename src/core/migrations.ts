/**
 * The database's schema, as versioned SQL migrations. Each is applied once, in order, inside one transaction, and
 * recorded in the `migrations` table. A migration is never edited after a release: a change is a new entry here.
 *
 * A database whose newest recorded migration is newer than the last one in this list was written by a newer Chamberlain,
 * and `openStore` refuses it (DatabaseTooNewError), the way migrate.ts refuses a config file from a newer build.
 *
 * Times: item and wake columns are epoch milliseconds (they are compared and added to); ledger columns that were ISO
 * strings in the files (rulings, butlers, decisions, the log) stay ISO strings.
 */
export type Migration = { version: number; name: string; sql: string };

export const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		name: "initial schema",
		sql: `
-- The one item system. A sweep finding, a decision-queue question, a dead-man alarm, a record of a wake that went out
-- once, a thing held for the operator's return: each is a row here, and one function (notification.ts,
-- decideNotification) decides when a row notifies.
--   state: PagerDuty's incident states. Whether anyone was notified is notification_count, not a state.
--   mode:  silenced (tracked, never notifies: an Alertmanager silence), shadow (counts what it WOULD have sent, in the
--          shadow_* columns, and notifies nobody), live.
--   dedup_key: stable and unique per source (PagerDuty's dedup_key): observing the same key again is the same item.
CREATE TABLE items (
	id INTEGER PRIMARY KEY,
	source TEXT NOT NULL,
	kind TEXT NOT NULL,
	dedup_key TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'triggered' CHECK (state IN ('triggered', 'acknowledged', 'resolved')),
	mode TEXT NOT NULL DEFAULT 'live' CHECK (mode IN ('silenced', 'shadow', 'live')),
	first_seen INTEGER NOT NULL,
	last_seen INTEGER NOT NULL,
	resolved_at INTEGER,
	notification_count INTEGER NOT NULL DEFAULT 0 CHECK (notification_count >= 0),
	next_notification_at INTEGER,
	shadow_notification_count INTEGER NOT NULL DEFAULT 0 CHECK (shadow_notification_count >= 0),
	shadow_next_notification_at INTEGER,
	subject_kind TEXT,
	subject_id TEXT,
	payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
	UNIQUE (source, dedup_key),
	CHECK ((subject_kind IS NULL) = (subject_id IS NULL))
);
CREATE INDEX items_by_state ON items (source, state);
CREATE INDEX items_by_subject ON items (subject_kind, subject_id) WHERE subject_kind IS NOT NULL;

-- The one-wake ledger. An item's one wake is claimed by inserting its row here; PRIMARY KEY (item_id) is the unique
-- constraint that makes the first claim win across processes. The claim carries the wake text and its delivery id.
CREATE TABLE claims (
	item_id INTEGER PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
	owner TEXT NOT NULL,
	delivery_id TEXT NOT NULL UNIQUE,
	message TEXT NOT NULL,
	claimed_at TEXT NOT NULL,
	answer TEXT CHECK (answer IS NULL OR json_valid(answer)),
	ruling TEXT CHECK (ruling IS NULL OR json_valid(ruling)),
	relay TEXT CHECK (relay IS NULL OR json_valid(relay))
);

-- The one direct send of a thread-routed answer: a started row with no outcome is a send cut short.
CREATE TABLE relays (
	item_id INTEGER PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
	started_at TEXT NOT NULL,
	outcome TEXT CHECK (outcome IS NULL OR outcome IN ('delivered', 'failed')),
	detail TEXT,
	finished_at TEXT
);

-- Evidence blobs stay files under <cache>/evidence/<item>/; these rows point to them and are all the page serves.
CREATE TABLE evidence (
	item_id INTEGER NOT NULL REFERENCES items (id) ON DELETE CASCADE,
	seq INTEGER NOT NULL,
	type TEXT NOT NULL CHECK (type IN ('image', 'video', 'link')),
	name TEXT,
	url TEXT,
	caption TEXT,
	PRIMARY KEY (item_id, seq)
);

CREATE TABLE rulings (
	id TEXT PRIMARY KEY,
	seq INTEGER NOT NULL UNIQUE,
	date TEXT NOT NULL,
	words TEXT NOT NULL,
	decides TEXT NOT NULL,
	source TEXT NOT NULL CHECK (source IN ('chat', 'card')),
	status TEXT NOT NULL CHECK (status IN ('in-force', 'proposed', 'retired')),
	confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
	confirmed_at TEXT,
	retired_at TEXT,
	retired_how TEXT CHECK (retired_how IS NULL OR retired_how IN ('retired', 'only this once')),
	item TEXT,
	history TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(history))
);

-- The Steward's self-answers, citing rulings. Append-only.
CREATE TABLE decisions (
	id INTEGER PRIMARY KEY,
	t TEXT NOT NULL,
	thread TEXT NOT NULL,
	decision TEXT NOT NULL,
	ruling TEXT NOT NULL,
	ruling_ids TEXT CHECK (ruling_ids IS NULL OR json_valid(ruling_ids)),
	ref TEXT
);
CREATE INDEX decisions_by_time ON decisions (t);

CREATE TABLE butlers (
	id TEXT PRIMARY KEY,
	thread TEXT NOT NULL,
	machine TEXT NOT NULL,
	model TEXT NOT NULL,
	scope TEXT NOT NULL,
	started TEXT NOT NULL,
	stopped TEXT,
	reason TEXT
);

-- The away record: the row with no exited_at is the current absence, and there is at most one.
CREATE TABLE away (
	id INTEGER PRIMARY KEY,
	entered_at TEXT NOT NULL,
	words TEXT NOT NULL,
	expected_return TEXT,
	spend_note TEXT,
	exited_at TEXT
);
CREATE UNIQUE INDEX away_current ON away ((1)) WHERE exited_at IS NULL;

-- Wakes. Outbox (the transactional outbox pattern): one process's wakes not yet accepted by the transport, written before
-- the first send. delivered_wakes: the shared ledger of accepted wakes, so none is sent twice. held_wakes: wakes waiting for the
-- Steward to go idle, to go out as one digest, shared by the daemon and the page. delivery_id is the wake's message id,
-- stable across retries and sent with it (GitHub's X-GitHub-Delivery is the same kind of id).
CREATE TABLE outbox (
	delivery_id TEXT PRIMARY KEY,
	owner TEXT NOT NULL,
	message TEXT NOT NULL,
	queued_at INTEGER NOT NULL,
	kind TEXT,
	thread TEXT
);
CREATE TABLE delivered_wakes (
	delivery_id TEXT PRIMARY KEY,
	delivered_at INTEGER NOT NULL
);
CREATE TABLE held_wakes (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	delivery_id TEXT NOT NULL UNIQUE,
	message TEXT NOT NULL,
	queued_at INTEGER NOT NULL,
	kind TEXT,
	thread TEXT
);

-- The daemon's event log: every wake, skip, alarm and answer. queue-waits.ts and the history tools read it with SQL.
CREATE TABLE events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	t TEXT NOT NULL,
	event TEXT NOT NULL,
	src TEXT,
	data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
	import_key TEXT UNIQUE
);
CREATE INDEX events_by_event ON events (event, t);
CREATE INDEX events_by_time ON events (t);

-- Small named records: the hold store's gate clock, what rights text the Steward last received, the sweep clock, the
-- latest health verdict, the heartbeat.
CREATE TABLE state (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL CHECK (json_valid(value)),
	updated_at INTEGER NOT NULL
);
`,
	},
	{
		version: 2,
		name: "delivery leases",
		sql: `
-- A lease on one outbox row, taken in a transaction before its POST, so two processes that own the same outbox (two daemons)
-- never POST the same wake at once. The holder is a per-instance uuid with its pid and host; the lease ends when it expires, or, on
-- the same host, when the holder's process is gone (so a restart takes over a crashed process's row at once). Removed with its row.
CREATE TABLE delivery_leases (
	delivery_id TEXT PRIMARY KEY REFERENCES outbox (delivery_id) ON DELETE CASCADE,
	holder TEXT NOT NULL,
	pid INTEGER NOT NULL,
	host TEXT NOT NULL,
	expires_at INTEGER NOT NULL
);
`,
	},
	{
		version: 3,
		name: "confirmation challenges",
		sql: `
-- The server-side confirm step for approvals (and goal proposals). Step one issues a single-use, expiring token bound to the card's
-- fingerprint, the chosen decision and the browser session; step two consumes it. Only the token's hash is stored: the database never
-- holds a value that could be presented. A consumed or expired row is terminal and pruned.
CREATE TABLE confirmation_challenges (
	token_hash TEXT PRIMARY KEY,
	card_id TEXT NOT NULL,
	sig TEXT NOT NULL,
	choice INTEGER NOT NULL CHECK (choice >= 0),
	session_hash TEXT NOT NULL,
	issued_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	consumed_at INTEGER
);
CREATE INDEX confirmation_challenges_by_card ON confirmation_challenges (card_id, session_hash);
`,
	},
	{
		version: 4,
		name: "delivery lease boot id",
		sql: `
-- Where a lease holder runs, so a forward jump of the wall clock cannot take a lease from a live holder. The boot id (Linux boot_id; macOS
-- kern.bootsessionuuid or kern.boottime) is NULL for a lease taken before this migration or on a platform that will not say; such a lease
-- is decided by its expiry alone. On the same host and boot a lease is taken over only when its holder's pid is gone.
ALTER TABLE delivery_leases ADD COLUMN boot TEXT;
`,
	},
	{
		version: 5,
		name: "delivery attempts and dead letters",
		sql: `
-- How many times a pending wake has been POSTed, recorded in the same transaction that takes the lease, BEFORE each POST (so a crash or a lost
-- response still counts). After the cap (default 3) with the wake never landed it is not POSTed again: status 'dead_letter', kept, with an alarm,
-- until the operator retries it (back to 'pending', attempts 0) or cancels it ('cancelled': the row stays so a recovered claim cannot queue it again).
-- A POST the transport certainly did not accept (an HTTP answer that is not 2xx, a refused connection) gives its attempt back.
ALTER TABLE outbox ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0);
ALTER TABLE outbox ADD COLUMN status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dead_letter', 'cancelled'));
ALTER TABLE outbox ADD COLUMN dead_at INTEGER;
`,
	},
	{
		version: 6,
		name: "transactional outbox with one relay",
		sql: `
-- One relay (the daemon) sends every wake; every other process only inserts outbox rows. Leases, the per-process owner, the shared
-- delivered ledger and the hold store's digest records are gone: an outbox row's status is the ledger.
DROP TABLE delivery_leases;
ALTER TABLE outbox RENAME TO outbox_v5;
-- An outbox row is immutable once created: its delivery id, its text and (for a digest) its members are frozen in the transaction that
-- creates it. Only status, attempts and the two times move, and a delivered or cancelled row never changes again.
CREATE TABLE outbox (
	id INTEGER PRIMARY KEY,
	delivery_id TEXT NOT NULL UNIQUE,
	message TEXT NOT NULL,
	kind TEXT,
	thread TEXT,
	created_at INTEGER NOT NULL,
	folded INTEGER NOT NULL DEFAULT 0 CHECK (folded >= 0),
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead_letter', 'cancelled')),
	attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	last_attempt_at INTEGER,
	finished_at INTEGER
);
CREATE INDEX outbox_by_status ON outbox (status, id);
-- What each row carries: its own delivery id, or a digest's members. The primary key is the UNIQUE that binds an item to at most one row, ever.
CREATE TABLE outbox_members (
	delivery_id TEXT PRIMARY KEY,
	outbox_id INTEGER NOT NULL REFERENCES outbox (id) ON DELETE CASCADE,
	queued_at INTEGER NOT NULL,
	kind TEXT,
	thread TEXT
);
CREATE INDEX outbox_members_by_row ON outbox_members (outbox_id);
CREATE TRIGGER outbox_frozen BEFORE UPDATE OF delivery_id, message, kind, thread, created_at, folded ON outbox
BEGIN SELECT RAISE(ABORT, 'an outbox row is immutable once created'); END;
CREATE TRIGGER outbox_terminal BEFORE UPDATE ON outbox WHEN OLD.status IN ('delivered', 'cancelled')
BEGIN SELECT RAISE(ABORT, 'a delivered or cancelled outbox row never changes'); END;
CREATE TRIGGER outbox_kept BEFORE DELETE ON outbox WHEN OLD.status IN ('pending', 'dead_letter')
BEGIN SELECT RAISE(ABORT, 'only a delivered or cancelled outbox row is ever deleted'); END;
CREATE TRIGGER outbox_members_frozen BEFORE UPDATE ON outbox_members
BEGIN SELECT RAISE(ABORT, 'an outbox member binding is immutable'); END;
INSERT INTO outbox (delivery_id, message, kind, thread, created_at, status, attempts, finished_at)
	SELECT o.delivery_id, o.message, o.kind, o.thread, o.queued_at, CASE WHEN d.delivery_id IS NULL THEN o.status ELSE 'delivered' END, o.attempts, COALESCE(d.delivered_at, o.dead_at)
	FROM outbox_v5 o LEFT JOIN delivered_wakes d ON d.delivery_id = o.delivery_id ORDER BY o.queued_at, o.rowid;
INSERT INTO outbox (delivery_id, message, created_at, status, finished_at)
	SELECT delivery_id, '', delivered_at, 'delivered', delivered_at FROM delivered_wakes WHERE delivery_id NOT IN (SELECT delivery_id FROM outbox);
INSERT INTO outbox_members (delivery_id, outbox_id, queued_at, kind, thread) SELECT delivery_id, id, created_at, kind, thread FROM outbox;
DELETE FROM held_wakes WHERE delivery_id IN (SELECT delivery_id FROM outbox_members);
DROP TABLE outbox_v5;
DROP TABLE delivered_wakes;
-- The gate clock now lives in the relay. A digest recorded here was never bound: its members are still held and are composed again.
DELETE FROM state WHERE key = 'hold-gate';
`,
	},
	{
		version: 7,
		name: "permanent tombstones for delivered and cancelled wakes",
		sql: `
-- Retention deletes a delivered or cancelled outbox row, and the row's member bindings go with it (ON DELETE CASCADE), which made its ids
-- enqueueable again. One compact row per delivery id that was delivered or cancelled outlives the row: it is never updated or deleted, and
-- enqueue and hold check it, so "an item is bound to one row, ever" holds past retention too.
CREATE TABLE wake_tombstones (
	delivery_id TEXT PRIMARY KEY,
	outcome TEXT NOT NULL CHECK (outcome IN ('delivered', 'cancelled')),
	ended_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TRIGGER wake_tombstones_permanent BEFORE UPDATE ON wake_tombstones
BEGIN SELECT RAISE(ABORT, 'a wake tombstone is permanent'); END;
CREATE TRIGGER wake_tombstones_kept BEFORE DELETE ON wake_tombstones
BEGIN SELECT RAISE(ABORT, 'a wake tombstone is permanent'); END;
-- Written by the database in the same statement that ends the row, for every id the row carries (a digest's members included), so no code path can forget it.
CREATE TRIGGER outbox_tombstone AFTER UPDATE OF status ON outbox WHEN NEW.status IN ('delivered', 'cancelled')
BEGIN
	INSERT OR IGNORE INTO wake_tombstones (delivery_id, outcome, ended_at) SELECT delivery_id, NEW.status, COALESCE(NEW.finished_at, 0) FROM outbox_members WHERE outbox_id = NEW.id;
END;
INSERT OR IGNORE INTO wake_tombstones (delivery_id, outcome, ended_at)
	SELECT m.delivery_id, o.status, COALESCE(o.finished_at, 0) FROM outbox o JOIN outbox_members m ON m.outbox_id = o.id WHERE o.status IN ('delivered', 'cancelled');
`,
	},
	{
		version: 8,
		name: "wake receivers (the Alert Desk lane)",
		sql: `
-- A wake goes to a receiver (Alertmanager's term for the integration a notification is sent to). NULL is the Steward, as every row so far;
-- "desk" is the Alert Desk's own thread, with its own transport and gate in the one relay. A held wake waits for ITS receiver's thread to go idle, and a
-- digest only ever holds one receiver's wakes. The receiver is frozen with the row, like its text.
ALTER TABLE outbox ADD COLUMN receiver TEXT;
ALTER TABLE held_wakes ADD COLUMN receiver TEXT;
DROP TRIGGER outbox_frozen;
CREATE TRIGGER outbox_frozen BEFORE UPDATE OF delivery_id, message, kind, thread, created_at, folded, receiver ON outbox
BEGIN SELECT RAISE(ABORT, 'an outbox row is immutable once created'); END;
CREATE INDEX outbox_by_receiver ON outbox (receiver, status, id);
`,
	},
];

export const LATEST_MIGRATION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
