import { expect } from "bun:test";
import { deskAskCommand } from "../core/desk/alert-desk-prompt.ts";
import { parseShapes } from "../core/desk-shapes.ts";
import { checkCommand } from "../desk-allowlist.ts";

export const HOME = process.env.HOME!;

/** The one command the desk may run to file a decision: `bun $DESK_ASK_PATH`, else this build's own `ask`. */
export const ASK = deskAskCommand();

/** The operator's morning sources, as alert-desk.json would list them (`<N>` is a number). Nothing of the kind is built in. */
export const MONITOR = "/opt/monitor/report.ts";

const MORNING = [
	`bun ${MONITOR} heartbeat --json`,
	`bun ${MONITOR} list --limit <N> --json`,
	`docker exec -u svc db1 sh -lc "printf 'SELECT time, host, state FROM events WHERE time >= <N>\\n' | query"`,
];

/**
 * A wrapper only one install has, declared the way alert-desk.json's `commandShapes` declares it. Nothing of the kind is built in.
 * (`opsctl` stands in for any read-only CLI.)
 */
const SHAPES = parseShapes({
	opsctl: {
		bare: true,
		subcommands: {
			health: { positional: "word", max: 1 },
			docker: { max: 0 },
			service: { positional: "word", min: 1, max: 1 },
			network: { positional: ["ports"], max: 1 },
			journal: { flags: { "--limit": "digits" }, positional: "word", min: 1, max: 1 },
		},
	},
});

export const OPS = { morning: MORNING, shapes: SHAPES };

/** The gatherer agent the operator named in alert-desk.json. */
export const GATHERER = "evidence-reader";

export const refused = (cmd: string) => {
	const v = checkCommand(cmd, OPS);
	expect(v.ok).toBe(false);
	return v.ok ? "" : v.reason;
};

export const allowed = (cmd: string) => expect(checkCommand(cmd, OPS)).toEqual({ ok: true });
