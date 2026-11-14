/**
 * The files the program reads at run time, imported with `type: "file"` so `bun build --compile` embeds them in the binary
 * (scripts/build.ts). Run from a checkout, each is the path of the real file; run from the binary, it is a path inside the binary
 * that `readFileSync` and `Bun.file` read the same way. Nothing else may reach for `docs/` or `src/web/static/` by a path built from `REPO`.
 */

import deskPrompt from "../docs/alert-desk-prompt.md" with { type: "file" };
import startPrompt from "../docs/steward-start.md" with { type: "file" };
import sweepPrompt from "../docs/steward-sweep-prompt.md" with { type: "file" };
import wakePrompt from "../docs/steward-wake-prompt.md" with { type: "file" };
import appCss from "./web/static/app.css" with { type: "file" };
// @ts-expect-error TS7016: a script imported as a file is just its path, and has no declaration to find.
import appJs from "./web/static/app.js" with { type: "file" };
import indexHtml from "./web/static/index.html" with { type: "file" };
// @ts-expect-error TS7016: same.
import inlineJs from "./web/static/inline.js" with { type: "file" };

/** The Steward's full-sweep prompt template (docs/steward-sweep-prompt.md). */
export const SWEEP_PROMPT_FILE: string = sweepPrompt;
/** The first message of a new Steward thread (docs/steward-start.md), a template `chamberlain brief start` fills in. */
export const START_PROMPT_FILE: string = startPrompt;
/** The prompt of the Steward's wake task (docs/steward-wake-prompt.md), printed as it is by `chamberlain brief wake-prompt`. */
export const WAKE_PROMPT_FILE: string = wakePrompt;
/** The Alert Desk's standing prompt template (docs/alert-desk-prompt.md). */
export const DESK_PROMPT_FILE: string = deskPrompt;
/** The decision-queue page's static files, by the URL path each is served at. */
export const STATIC_FILES: Record<string, string> = {
	"/index.html": indexHtml as unknown as string,
	"/app.css": appCss,
	"/app.js": appJs as string,
	"/inline.js": inlineJs as string,
};
