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
function segmentReadsThread(segment: string): boolean {
	const [path, a, b, c] = runWords(segment);
	const cmd = path?.split("/").at(-1);
	if (cmd === "chamberlain") {
		const [x, y] = a === "debug" ? [b, c] : [a, b];
		return x === "peek" || (x === "t3x" && y === "read");
	}
	if (cmd !== "bun" || !a) return false;
	return /(?:^|\/)peek\.ts$/.test(a) || (/(?:^|\/)t3x\.ts$/.test(a) && b === "read");
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
			.some(segmentReadsThread));

/** The command with every quoted string emptied, so a separator or a command name inside quotes is not read as one. */
const unquoted = (command: string) => command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
