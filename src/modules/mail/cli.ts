/**
 * `chamberlain mail`: the email triage module's command (docs/EMAIL-TRIAGE.md). With the module off (no `mail` section in config.json, or
 * `"provider": "none"`) it says so, makes no file and exits 0. With it on, B1 has one verb, `status`: the settings in force and the schema
 * of `mail.db`. It reads and changes no mailbox. The verbs the later pieces add (`run`, `pause`, `undo`, `rules`, `measure`) are issues #35 to #42.
 */
import { CONF, STATE } from "../../core/config.ts";
import { cfg } from "../../core/layout.ts";
import { parseMail } from "./config.ts";
import { openMailDb } from "./db.ts";

export const OFF = "mail triage is off (config.json `mail.provider`)";

const USAGE = "usage: chamberlain mail [status]";

/** Runs `chamberlain mail ...`. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
	const c = parseMail(cfg(CONF, "mail"));
	if (c.provider === "none") {
		console.log(OFF);
		return;
	}
	const [sub, ...rest] = argv;
	if (sub === "help" || sub === "--help" || sub === "-h") {
		console.log(USAGE);
		return;
	}
	if ((sub !== undefined && sub !== "status") || rest.length)
		throw Error(`mail: unknown command "${argv.join(" ")}"\n${USAGE}`);
	const db = openMailDb(STATE);
	try {
		const v = db.one("SELECT MAX(version) AS v FROM migrations")?.v;
		console.log(
			[
				`mail triage: on (provider ${c.provider}, mode ${c.mode})`,
				`mail.db: ${db.path}, schema ${v}`,
				`schedule: ${c.schedule.times.join(", ") || "only when the Steward runs it"}, ${c.schedule.days}, ${c.schedule.tz}`,
				`models: driver ${c.models.driver}, escalate ${c.models.escalate}, top ${c.models.top}`,
				`unattended archive: off (docs/EMAIL-TRIAGE.md, section 5)`,
			].join("\n"),
		);
	} finally {
		db.close();
	}
}

if (import.meta.main) await main();
