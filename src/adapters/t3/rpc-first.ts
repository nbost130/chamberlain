/** First authenticated stream value; callers own the socket and close it in finally. */
import { within } from "../../core/within.ts";
import type { Rpc } from "./rpc.ts";

export function firstValue(rpc: Pick<Rpc, "call">, method: string, payload: unknown): Promise<unknown> {
	return within(
		new Promise((resolve, reject) => {
			rpc.call(method, payload, resolve).then(() => reject(Error("stream ended before its snapshot")), reject);
		}),
		15_000,
		"T3 snapshot",
	);
}
