import { openDatabase, type Schema } from "../store/database.ts";
import { SchemaTooNewError } from "../store/schema.ts";
import type { DistillReport } from "./report.ts";

/** This additive migration is scoped to the report sidecar so a rollback can still open the ledger and telemetry. */
const schema: Schema = {
	migrations: [
		{
			version: 22,
			name: "weekly distillation",
			sql: `
CREATE TABLE distill_weekly (
	week_start TEXT NOT NULL,
	definition_version INTEGER NOT NULL,
	report TEXT NOT NULL CHECK (json_valid(report)),
	PRIMARY KEY (week_start, definition_version)
);
`,
		},
	],
	tooNew: (path, found) => new SchemaTooNewError(path, found, schema.migrations.at(-1)?.version ?? 0, "migration"),
};

export function saveDistillWeek(state: string, report: DistillReport): void {
	if (!report.week) return;
	const db = openDatabase(`${state}/distill.db`, {}, schema);
	try {
		db.run(
			`INSERT INTO distill_weekly (week_start, definition_version, report) VALUES (?, ?, ?)
			ON CONFLICT (week_start, definition_version) DO UPDATE SET report = excluded.report
			WHERE report <> excluded.report`,
			[report.week, report.definitionVersion, JSON.stringify(report)],
		);
	} finally {
		db.close();
	}
}
