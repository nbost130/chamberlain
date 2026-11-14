/**
 * Which T3 Code server versions this build has been tested against. One place: the README's Compatibility section
 * repeats it, and the daemon warns (and keeps running) when a server is outside it.
 *
 *   bun src/adapters/t3/compat.ts [<origin>]     print what a server reports and whether it is in the tested range
 *
 * Chamberlain relies on T3 internals (see docs/upstream-asks.md): the orchestration protocol over /ws, the shell
 * stream, `runtime-request.respond`, and a read-only look at T3's `statev2.sqlite`. A newer T3 can change any of them.
 */
export const T3_TESTED = {
	/** Oldest and newest T3 server version exercised, inclusive. */
	min: "0.1.8",
	max: "0.1.9",
	/** The orchestration protocol the daemon speaks (`orchestrationProtocol=2` on the socket). */
	orchestrationProtocol: 2,
} as const;

export type ServerEnvironment = { serverVersion?: unknown; orchestrationProtocolVersion?: unknown };

/** Pure: why a server is outside the tested range, or undefined when it is inside. Unknown values are reported, never assumed fine. */
export function compatWarning(env: ServerEnvironment | undefined, tested = T3_TESTED): string | undefined {
	if (!env) return "could not read the server's version, so compatibility is unchecked";
	const v = env.serverVersion;
	const out: string[] = [];
	if (typeof v !== "string" || !/^\d+\.\d+\.\d+/.test(v)) out.push(`the server reports no usable version (${JSON.stringify(v)})`);
	else if (Bun.semver.order(v, tested.min) < 0 || Bun.semver.order(v, tested.max) > 0) out.push(`T3 ${v} is outside the tested range ${tested.min} to ${tested.max}`);
	if (env.orchestrationProtocolVersion !== tested.orchestrationProtocol) out.push(`it speaks orchestration protocol ${JSON.stringify(env.orchestrationProtocolVersion)}, not ${tested.orchestrationProtocol}`);
	return out.length ? `${out.join("; ")}. Chamberlain may misread threads or miss wakes; check docs/upstream-asks.md and the README's Compatibility section.` : undefined;
}

/** Reads T3's unauthenticated environment document. Never throws: a failure is `undefined`. */
export async function readEnvironment(origin: string, doFetch: typeof fetch = fetch): Promise<ServerEnvironment | undefined> {
	try {
		const r = await doFetch(new URL("/.well-known/t3/environment", origin), { signal: AbortSignal.timeout(8000) });
		if (!r.ok) return undefined;
		const body = (await r.json()) as unknown;
		return body && typeof body === "object" ? (body as ServerEnvironment) : undefined;
	} catch {
		return undefined;
	}
}

export async function main(argv: string[] = process.argv.slice(2)) {
	const origin = argv[0] ?? process.env.CHAMBERLAIN_T3_ORIGIN ?? "http://127.0.0.1:3773";
	const env = await readEnvironment(origin);
	console.log(`${origin}: T3 ${String(env?.serverVersion ?? "unknown")}, protocol ${String(env?.orchestrationProtocolVersion ?? "unknown")}; tested ${T3_TESTED.min} to ${T3_TESTED.max}, protocol ${T3_TESTED.orchestrationProtocol}`);
	const w = compatWarning(env);
	console.log(w ? `WARNING: ${w}` : "inside the tested range");
	process.exit(w ? 1 : 0);
}

if (import.meta.main) await main();
