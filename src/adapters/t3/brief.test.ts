import { expect, test } from "bun:test";
import { stewardBrief } from "../../core/brief.ts";
import { t3Brief } from "./brief.ts";

test("T3's notes give the hand-off its tools: peek, the t3_* tools and t3x", () => {
	const b = stewardBrief({ mode: "live", repo: "/opt/chamberlain", principal: "Ada", rights: "r", rulings: "x", operatingRules: "", afk: undefined, environments: [{ name: "main" }], predecessor: undefined, notes: t3Brief({ repo: "/opt/chamberlain" }) });
	for (const x of ["You run Ada's T3 threads", "watches every T3 server", "bun /opt/chamberlain/src/adapters/t3/peek.ts <server> <threadId>", "about a tenth of what `t3_thread_read` costs", "`t3_pending_request` stays off it", "The ordinary `t3_*` tools act on every machine:", "/opt/chamberlain/src/adapters/t3/t3x.ts threads|read|respond|send <server>"]) expect(b).toContain(x);
});
