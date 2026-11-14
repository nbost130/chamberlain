/**
 * The T3 adapter's `setTitle`: renames the Decisions thread through T3's thread.metadata.update command, which needs the
 * orchestration:operate token. Without the token the title stays as it was.
 */
import { readFileSync, statSync } from "node:fs";
import { isPrivateFile } from "../../core/private.ts";
import { connect } from "./rpc.ts";

export type SetTitle = (title: string) => Promise<"set" | "no-token" | "failed">;

/** The live renamer for one T3 server and thread. */
export function t3TitleSetter(conf: string, origin: string, tokenFile: string, threadId: string): SetTitle {
	return async (title) => {
		let token: string;
		try {
			const p = `${conf}/${tokenFile}`;
			if (!isPrivateFile(statSync(p))) return "failed";
			token = readFileSync(p, "utf8").trim();
			if (!token) return "no-token";
		} catch {
			// EMPTY_CATCH_OK: a missing token file is the normal state until the operate token is configured; the title stays fixed.
			return "no-token";
		}
		const rpc = await connect(origin, token);
		try {
			await rpc.request("orchestration.dispatchCommand", {
				type: "thread.metadata.update",
				commandId: crypto.randomUUID(),
				threadId,
				title,
			});
			return "set";
		} finally {
			rpc.ws.close();
		}
	};
}
