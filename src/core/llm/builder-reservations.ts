import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { holdFlock } from "../flock.ts";
import { DIR_MODE } from "../private.ts";
import { type Db, openDatabase, openReadOnlyDatabase, queries, type Schema } from "../store/database.ts";

const schema: Schema = {
	migrations: [
		{
			version: 1,
			name: "builder reservations",
			sql: `CREATE TABLE builder_reservations (
				request_id TEXT PRIMARY KEY,
				binding TEXT NOT NULL,
				attempt_id TEXT NOT NULL,
				scope TEXT NOT NULL,
				plan TEXT NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'released')),
				thread_id TEXT,
				reconciled_at INTEGER,
				CHECK ((status = 'confirmed') = (thread_id IS NOT NULL))
			)`,
		},
	],
	tooNew: (path, found) => Error(`builder reservation database ${path} has unsupported schema version ${found}`),
};

export type BuilderReservation<Plan> = {
	requestId: string;
	attemptId: string;
	scope: string;
	plan: Plan;
} & ({ status: "pending" | "released"; threadId?: never } | { status: "confirmed"; threadId: string });

type ObservedThreads = ReadonlyMap<string, ReadonlySet<string>>;
type Probe = { observed: ObservedThreads; snapshotStartedAt: number };

function reservation<Plan>(row: Record<string, unknown>): BuilderReservation<Plan> {
	const base = {
		requestId: row.request_id as string,
		attemptId: row.attempt_id as string,
		scope: row.scope as string,
		plan: JSON.parse(row.plan as string) as Plan,
	};
	if (row.status === "confirmed") return { ...base, status: "confirmed", threadId: row.thread_id as string };
	return { ...base, status: row.status as "pending" | "released" };
}

function held<Plan>(db: Db, probe?: Probe): BuilderReservation<Plan>[] {
	const { observed, snapshotStartedAt } = probe ?? {};
	const rows = db.all("SELECT * FROM builder_reservations WHERE status <> 'released'");
	return rows
		.filter((row) => {
			if (row.status !== "confirmed") return true;
			if (observed?.get(row.scope as string)?.has(row.thread_id as string)) return false;
			// Older probes can arrive after reconciliation and still omit the new thread from their load.
			return (
				typeof row.reconciled_at !== "number" ||
				snapshotStartedAt === undefined ||
				snapshotStartedAt <= row.reconciled_at
			);
		})
		.map(reservation<Plan>);
}

function reconcile(db: Db, observed: ObservedThreads): void {
	const rows = db.all(
		"SELECT request_id, scope, thread_id FROM builder_reservations WHERE status = 'confirmed' AND reconciled_at IS NULL",
	);
	for (const row of rows) {
		if (observed.get(row.scope as string)?.has(row.thread_id as string)) {
			db.run("UPDATE builder_reservations SET reconciled_at = ? WHERE request_id = ?", Date.now(), row.request_id);
		}
	}
}

function lookup<Plan>(db: Db, requestId: string, binding: string): BuilderReservation<Plan> | undefined {
	const row = db.one("SELECT * FROM builder_reservations WHERE request_id = ?", requestId);
	if (!row) return undefined;
	if (row.binding !== binding) throw Error(`builder request ${requestId} is already bound to another role or project`);
	return reservation<Plan>(row);
}

/** A pending row is committed before the launcher may call T3. It survives an ambiguous response or a crash. */
export class BuilderReservations<Plan> {
	private readonly dir: string;
	private readonly path: string;

	constructor(state: string) {
		this.dir = join(state, "builder-reservations");
		this.path = join(this.dir, "reservations.db");
	}

	private use<T>(action: (db: Db) => T): T {
		mkdirSync(this.dir, { recursive: true, mode: DIR_MODE });
		// A concurrent first open can receive SQLITE_BUSY while switching SQLite to WAL.
		const lock = holdFlock(this.dir, { waitMs: 10_000 });
		try {
			const connection = openDatabase(this.path, {}, schema);
			try {
				return action(queries(connection));
			} finally {
				connection.close();
			}
		} finally {
			lock.release();
		}
	}

	private read<T>(action: (db: Db) => T, empty: () => T): T {
		if (!existsSync(this.path)) return empty();
		const connection = openReadOnlyDatabase(this.path);
		try {
			const db = queries(connection);
			// A writer may still be initializing the new file. No launch can have been reserved yet.
			const tables = db.all("SELECT name FROM sqlite_schema WHERE name IN ('migrations', 'builder_reservations')");
			if (tables.length < 2) return empty();
			const found = db.one("SELECT MAX(version) AS version FROM migrations")?.version as number;
			if (found > 1) throw schema.tooNew(this.path, found);
			return action(db);
		} finally {
			connection.close();
		}
	}

	get(requestId: string, binding: string): BuilderReservation<Plan> | undefined {
		return this.read(
			(db) => lookup<Plan>(db, requestId, binding),
			() => undefined,
		);
	}

	preview<T>(choose: (rows: readonly BuilderReservation<Plan>[]) => T, probe?: Probe): T {
		return this.read(
			(db) => choose(held<Plan>(db, probe)),
			() => choose([]),
		);
	}

	reserve(
		requestId: string,
		binding: string,
		choose: (rows: readonly BuilderReservation<Plan>[]) => { plan: Plan; scope: string },
		probe?: Probe,
	): { acquired: boolean; reservation: BuilderReservation<Plan> } {
		return this.use((db) => {
			// Record evidence even when the new request cannot find a qualified builder.
			if (probe?.observed.size) db.tx(() => reconcile(db, probe.observed));
			return db.tx(() => {
				const existing = lookup<Plan>(db, requestId, binding);
				if (existing && existing.status !== "released") return { acquired: false, reservation: existing };
				const { plan, scope } = choose(held<Plan>(db, probe));
				const attemptId = randomUUID();
				db.run(
					`INSERT INTO builder_reservations (request_id, binding, attempt_id, scope, plan, status)
					VALUES (?, ?, ?, ?, ?, 'pending')
					ON CONFLICT (request_id) DO UPDATE SET
						attempt_id = excluded.attempt_id, scope = excluded.scope, plan = excluded.plan, status = excluded.status`,
					requestId,
					binding,
					attemptId,
					scope,
					JSON.stringify(plan),
				);
				return { acquired: true, reservation: { requestId, attemptId, scope, plan, status: "pending" } };
			});
		});
	}

	complete(requestId: string, attemptId: string, threadId: string): void {
		this.use((db) => {
			const change = db.run(
				`UPDATE builder_reservations SET status = 'confirmed', thread_id = ?
				WHERE request_id = ? AND attempt_id = ? AND (status = 'pending' OR thread_id = ?)`,
				threadId,
				requestId,
				attemptId,
				threadId,
			);
			if (!change.changes) throw Error(`builder request ${requestId} has no matching launch reservation`);
		});
	}

	/** Only release after receiving evidence that the launch did not create a T3 thread. */
	release(requestId: string, attemptId: string): void {
		this.use((db) => {
			const change = db.run(
				`UPDATE builder_reservations SET status = 'released'
				WHERE request_id = ? AND attempt_id = ? AND status IN ('pending', 'released')`,
				requestId,
				attemptId,
			);
			if (!change.changes) throw Error(`builder request ${requestId} has no matching unconfirmed launch reservation`);
		});
	}
}
