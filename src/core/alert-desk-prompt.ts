import { selfCommand } from "./config.ts";
import { describeShape, parseGatherer, parseShapes, type ShapeSet } from "./desk-shapes.ts";
import { configValue } from "./layout.ts";
import { CONFIG_FILE } from "./layout-schema.ts";

/**
 * The Morning sweep's own sources, the operator's (alert-desk.json): `morningCommands`, each run exactly as written (`<N>` stands for a
 * number the desk fills in; `<N:a-b>` gives it a width, `slotProblem`), and `morningNotes`, how to read them. src/desk-allowlist.ts allows exactly these commands, so they widen what
 * the desk may run: they are read only from an alert-desk.json the operator owns that no group or other user can write (`authorityProblem`).
 */
export type MorningSources = { commands: string[]; notes?: string };
/** The widest number a slot may take, in digits, whatever width it gives. */
const MAX_SLOT_DIGITS = 12;
/**
 * A number slot: `<N>` (1 to 12 digits), `<N:a-b>` (a to b digits, `<N:1-5>`) or `<N:a>` (exactly a digits), with 1 <= a <= b <= 12.
 * Anything else that starts `<N:` is a malformed slot, and the command holding it is left out (`slotProblem`).
 */
const SLOT = /<N(?::(\d{1,2})(?:-(\d{1,2}))?)?>/g;

/** Pure: why a morning command's number slots are malformed, or undefined when every slot is well formed. */
function slotProblem(command: string): string | undefined {
	for (const m of command.matchAll(SLOT)) {
		if (m[1] === undefined) continue;
		const lo = Number(m[1]),
			hi = m[2] === undefined ? lo : Number(m[2]);
		if (lo < 1 || hi < lo || hi > MAX_SLOT_DIGITS)
			return `${m[0]} is not a width from 1 to ${MAX_SLOT_DIGITS} digits (<N:a-b> with a <= b)`;
	}
	if (command.replace(SLOT, "").includes("<N:")) return `a number slot is written <N>, <N:a> or <N:a-b>`;
	return undefined;
}

/** Pure: the morning sources from a parsed alert-desk.json. Anything malformed is left out (`warn` says which, and why). */
export function parseMorning(raw: unknown, warn: (msg: string) => void = () => {}): MorningSources {
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const listed = Array.isArray(o.morningCommands)
		? o.morningCommands
				.filter(
					(c): c is string => typeof c === "string" && c.trim().length > 0 && c.length <= 2000 && !c.includes("\n"),
				)
				.map((c) => c.trim())
		: [];
	const commands = listed.filter((c) => {
		const bad = slotProblem(c);
		if (bad) warn(`alert desk: ignoring the morning command ${JSON.stringify(c.slice(0, 120))}: ${bad}`);
		return !bad;
	});
	const notes = typeof o.morningNotes === "string" && o.morningNotes.trim() ? o.morningNotes.trim() : undefined;
	return { commands, ...(notes ? { notes } : {}) };
}

/**
 * What the operator adds to the desk in alert-desk.json: the morning sources, `commandShapes` (the command shapes of tools only their install
 * has: src/core/desk-shapes.ts) and `gatherer` (the name of the agent the desk may start to read evidence). All widen what the desk may run,
 * so all are read only from a file the operator owns that no group or other user can write.
 */
export type DeskOperator = { morning: MorningSources; shapes: ShapeSet; gatherer?: string };
const NONE = (): DeskOperator => ({ morning: { commands: [] }, shapes: {} });

/** Pure: the operator's additions from a parsed alert-desk.json. Anything malformed is left out (`warn` says which, and why). */
export function parseOperator(raw: unknown, warn: (msg: string) => void = () => {}): DeskOperator {
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	const gatherer = parseGatherer(o.gatherer, warn);
	return {
		morning: parseMorning(raw, warn),
		shapes: parseShapes(o.commandShapes, warn),
		...(gatherer ? { gatherer } : {}),
	};
}

/**
 * The operator's additions in the `alertDesk` section of config.json (else the legacy alert-desk.json), or none (with a warning saying why)
 * when the file is not the operator's alone. config.json is checked when it is read (src/core/layout.ts `readConfigFile`).
 */
export function readOperator(conf: string, warn: (msg: string) => void = () => {}): DeskOperator {
	let v: ReturnType<typeof configValue>;
	try {
		v = configValue(conf, "alertDesk");
	} catch (e) {
		warn(`alert desk: ignoring the operator's settings in ${conf}/${CONFIG_FILE}: ${(e as Error).message}`);
		return NONE();
	}
	if (!v) return NONE();
	if (v.trust) {
		warn(`alert desk: ignoring the operator's settings in ${conf}/${v.file}: ${v.trust}`);
		return NONE();
	}
	try {
		return parseOperator(v.value, warn);
	} catch (e) {
		warn(`alert desk: ignoring the operator's settings in ${conf}/${v.file}: ${(e as Error).message}`);
		return NONE();
	}
}

/** The morning sources in `<conf>/alert-desk.json` (see `readOperator`). */
export const readMorning = (conf: string, warn: (msg: string) => void = () => {}): MorningSources =>
	readOperator(conf, warn).morning;

/**
 * Pure: the pattern a morning command is matched by: the command exactly, with each `<N>` one to twelve digits and each `<N:a-b>` (or
 * `<N:a>`) a to b (exactly a) digits. A command with a malformed slot matches nothing (`slotProblem`): it fails closed.
 */
export function morningPattern(command: string): RegExp {
	if (slotProblem(command)) return /(?!)/;
	const esc = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	let out = "",
		at = 0;
	for (const m of command.matchAll(SLOT)) {
		const lo = m[1] === undefined ? 1 : Number(m[1]);
		const hi = m[1] === undefined ? MAX_SLOT_DIGITS : m[2] === undefined ? lo : Number(m[2]);
		if (m.index === undefined) throw Error("morningPattern: a matchAll result carries no index");
		out += `${esc(command.slice(at, m.index))}\\d{${lo},${hi}}`;
		at = m.index + m[0].length;
	}
	return new RegExp(`^${out}${esc(command.slice(at))}$`);
}

/** What the desk's standing prompt is filled with: who it works for, the server it runs on, the allowlist hook command, the ask command, the morning sources. */
export type DeskPromptVars = {
	principalName: string;
	serverName: string;
	allowlistHook: string;
	askCommand: string;
	morning: MorningSources;
	/** The operator's command shapes and gatherer agent (`readOperator`); none when omitted. */
	shapes?: ShapeSet;
	gatherer?: string;
};

/**
 * The one command the desk may run to file a decision: `bun $DESK_ASK_PATH` when that is set, else `chamberlain ask` from the compiled binary or
 * `bun <this checkout>/src/ask.ts` from source (the checkout the desk hook runs from). The allowlist accepts `<this command> '<json>'` and nothing
 * else for filing a decision, and the standing prompt is filled with the same command (`{{askCommand}}`), so the command the prompt teaches is the
 * command the hook allows.
 */
export const deskAskCommand = (
	env: Record<string, string | undefined> = process.env,
	o: { compiled?: boolean; repo?: string } = {},
) => (env.DESK_ASK_PATH ? `bun ${env.DESK_ASK_PATH}` : selfCommand("ask", o));

/** Pure: the morning sources as the prompt lists them. */
function morningSourcesText(m: MorningSources): string {
	if (!m.commands.length)
		return "   No morning sources are configured (`morningCommands` in alert-desk.json). Report what the morning wake carries, and say that no other source was read.";
	const code = (c: string) => (c.includes("`") ? `\`\` ${c} \`\`` : `\`${c}\``);
	return [
		...m.commands.map((c) => `   - ${code(c)}`),
		...(m.notes ? ["", ...m.notes.split("\n").map((l) => `   ${l}`.trimEnd())] : []),
	].join("\n");
}

/**
 * Pure: the desk's standing prompt from its template (docs/alert-desk-prompt.md): `<!-- -->` comments dropped, and `{{principalName}}`,
 * `{{serverName}}`, `{{allowlistHook}}`, `{{askCommand}}`, `{{morningSources}}`, `{{gatherStep}}`, `{{toolList}}` and `{{operatorCommands}}` filled in, the
 * way the sweep prompt is (sweep.ts `renderSweepPrompt`).
 */
export function renderDeskPrompt(template: string, v: DeskPromptVars): string {
	return (
		template
			.replace(/<!--[\s\S]*?-->\s*/g, "")
			.trim()
			.replaceAll("{{principalName}}", v.principalName)
			.replaceAll("{{serverName}}", v.serverName)
			.replaceAll("{{allowlistHook}}", v.allowlistHook)
			.replaceAll("{{askCommand}}", v.askCommand)
			.replaceAll("{{morningSources}}", morningSourcesText(v.morning))
			.replaceAll("{{gatherStep}}", () => gatherStepText(v.gatherer))
			.replaceAll("{{toolList}}", () => toolListText(v.gatherer))
			// The operator's own command shapes are bullets in the list of what may run: with none, the line goes, so no blank line splits the list.
			.replace(/\n\{\{operatorCommands\}\}(?=\n)/, () => operatorCommandsText(v.shapes ?? {}))
	);
}

/** Pure: the evidence-gathering step, which names the operator's gatherer agent when there is one. */
function gatherStepText(gatherer?: string): string {
	return gatherer
		? `Fan out at most 4 \`${gatherer}\` subagents for the family (Agent tool, \`subagent_type: "${gatherer}"\`). Brief each one with one narrow question and one read-only command or file, and nothing else. Do not read the logs yourself; you decide, they read.`
		: "No gatherer agent is configured, so read the evidence yourself: one narrow question at a time, each with one read-only command or file from the list below.";
}

/** Pure: the tools the desk has, which include the Agent tool only for the operator's gatherer. */
function toolListText(gatherer?: string): string {
	return gatherer
		? `Bash (in these shapes), Read, Grep, Glob and the Agent tool for \`${gatherer}\` gatherers`
		: "Bash (in these shapes), Read, Grep and Glob";
}

/** Pure: the operator's own command shapes as bullets for the list of what may run (empty when there are none). */
function operatorCommandsText(shapes: ShapeSet): string {
	return Object.entries(shapes)
		.map(([name, shape]) => `\n- ${describeShape(name, shape).join(", ")}.`)
		.join("");
}

// ---- events -----------------------------------------------------------------------------------------
