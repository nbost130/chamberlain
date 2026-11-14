/** Runs a command with `stdin` on its input and returns its output and exit code (null when a signal or the timeout ended it). stderr is dropped. */
export async function runPiped(
	argv: string[],
	stdin: string,
	timeoutMs: number,
	env?: Record<string, string | undefined>,
): Promise<{ code: number | null; stdout: string }> {
	const p = Bun.spawn(argv, {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
		...(env ? { env } : {}),
		timeout: timeoutMs,
	});
	p.stdin.write(stdin);
	await p.stdin.end();
	const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
	return { code: p.signalCode ? null : code, stdout };
}
