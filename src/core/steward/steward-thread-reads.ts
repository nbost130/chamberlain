/** Which of the Steward's tool calls read another thread: the verification reads a digest that says too little costs it. */

/** The words a shell segment runs, past a `timeout N`, `nice` or `VAR=value` prefix. */
function runWords(segment: string): string[] {
	const w = segment.trim().split(/\s+/);
	while (w.length && (/^\w+=/.test(w[0] ?? "") || w[0] === "nice" || w[0] === "timeout")) {
		if (w[0] === "timeout" && /^\d/.test(w[1] ?? "")) w.shift();
		w.shift();
	}
	return w;
}

/** Whether one shell segment runs a thread read: Chamberlain's peek or `t3x read`, as `chamberlain [debug] ...` or `bun .../peek.ts`. */
function readArgs(segment: string): string[] | undefined {
	const [path, ...args] = runWords(segment);
	const cmd = path?.split("/").at(-1);
	const [first = "", second, ...rest] = cmd === "chamberlain" && args[0] === "debug" ? args.slice(1) : args;
	const verb = cmd === "bun" ? first.split("/").at(-1)?.replace(/\.ts$/, "") : first;
	if (cmd !== "bun" && cmd !== "chamberlain") return undefined;
	if (verb === "peek") return second === undefined ? [] : [second, ...rest];
	if (verb === "t3x" && second === "read") return rest;
}

/**
 * Whether a tool call reads another thread: T3's thread read, or a shell command one of whose segments runs Chamberlain's peek or
 * `t3x read`. These are the verification reads a wake that does not say enough makes the Steward do. Only what a segment runs is looked
 * at: a word in an argument (`echo chamberlain peek`) is not a read.
 */
export const readsThread = (name: string, command: string): boolean =>
	/t3_thread_read$/.test(name) ||
	(name === "Bash" &&
		unquoted(command)
			.split(/[;&|\n]+/)
			.some((segment) => readArgs(segment) !== undefined));

/** A shell read's server and target. Ignore quoted command names and command-looking prose. */
export function shellThreadRead(command: string): string | undefined {
	for (const segment of unquoted(command).split(/[;&|\n]+/)) {
		const [server, thread] = readArgs(segment) ?? [];
		if (server && thread && /^[\w-]+$/.test(server) && /^[\w:-]+$/.test(thread)) return `${server}:${thread}`;
	}
}

/** The command with every quoted string emptied, so a separator or a command name inside quotes is not read as one. */
const unquoted = (command: string) => command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
