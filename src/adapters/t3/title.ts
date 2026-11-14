/**
 * The T3 adapter's `setTitle`: renames the Decisions thread through T3's thread.metadata.update command, which needs the
 * orchestration:operate token. Without the token the title stays as it was.
 */
import { readSecret } from "../../core/layout.ts";
import { connect } from "./rpc.ts";

export type SetTitle = (title: string) => Promise<"set" | "no-token" | "failed">;

/** The live renamer for one T3 server and thread. */
export function t3TitleSetter(conf: string, origin: string, tokenFile: string, threadId: string): SetTitle {
	return async (title) => {
		let token: string | undefined;
		try {
			token = readSecret(conf, tokenFile);
		} catch {
			return "failed"; // the file is there but is not a private regular file (mode exactly 0600)
		}
		if (!token) return "no-token"; // a missing token file is the normal state until the operate token is configured; the title stays fixed
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
