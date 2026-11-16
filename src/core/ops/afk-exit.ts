/** How `afk.ts` ends on a usage error or a failure. */

/** Prints a usage or refusal line and exits 2. */
export function usageExit(message: string): never {
	console.error(message);
	process.exit(2);
}

/** Prints the error of a command that failed and exits 1. */
export function failExit(e: unknown): never {
	console.error((e as Error).message);
	process.exit(1);
}
