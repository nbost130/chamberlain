/**
 * The email triage module (docs/EMAIL-TRIAGE.md), as the registry (src/modules/index.ts) holds it. B1 (#34) is the seam only: the config,
 * `mail.db`, the command and the shared model runner. It reads and changes no mailbox. The pieces that do work are B2 to B9 (#35 to #42).
 */
import type { Module } from "../../core/module.ts";
import { main } from "./cli.ts";
import { mailEnabled } from "./config.ts";
import { openMailDb } from "./db.ts";

export const mail: Module = {
	name: "mail",
	enabled: mailEnabled,
	start: (ctx) => {
		// The file is made here, on the first start with the module on, and never before.
		const db = openMailDb(ctx.state);
		ctx.log("mail.start", { schema: db.one("SELECT MAX(version) AS v FROM migrations")?.v });
		return { stop: () => db.close() };
	},
	main,
};
