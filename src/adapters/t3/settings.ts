/** The T3 adapter's two settings (settings.json keys read by the adapter): where T3 keeps its files. */
import { readSettings, tilde } from "../../core/config.ts";

const HOME = process.env.HOME;
/** T3's base directory: CHAMBERLAIN_T3_DIR, then settings.json, then ~/.t3. */
export const t3BaseDir = (): string =>
	tilde(process.env.CHAMBERLAIN_T3_DIR ?? readSettings().t3BaseDir ?? `${HOME}/.t3`);
/** T3's state database, read-only: CHAMBERLAIN_T3_STATE_DB, then settings.json, then <t3BaseDir>/userdata/statev2.sqlite. */
export const t3StateDbPath = (): string =>
	tilde(process.env.CHAMBERLAIN_T3_STATE_DB ?? readSettings().t3StateDb ?? `${t3BaseDir()}/userdata/statev2.sqlite`);
