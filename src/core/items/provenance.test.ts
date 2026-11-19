/** Who answered a decision is read from Chamberlain's record: a principal answer verifies, and nothing a message says can make another one. */
import { describe, expect, test } from "bun:test";
import { inspect, readArgs } from "../../decisions.ts";
import { answerOf, item, queue } from "../../testing/core-questions-fixtures.ts";
import { readProvenance, verify } from "./provenance.ts";
import { type Claim, claimWake, pageClaim } from "./questions-claim.ts";
import { threadRelayMessage } from "./questions-wake.ts";

const answered = item("Q-abcd1", { options: [{ label: "Approve the dependency", route: "thread", relay: "go" }] });
const answerA = { ...answerOf("Q-abcd1"), label: "Approve the dependency" };
const answeredStore = () => {
	const store = queue(answered);
	claimWake(store, pageClaim(answered, answerA));
	return store;
};

describe("decision provenance", () => {
	test("a principal answer made on the page verifies, with its key, time, choice and thread", () => {
		const p = readProvenance(answeredStore(), "Q-abcd1");
		expect(p).toMatchObject({
			answeredBy: "principal",
			via: "decision page",
			key: "page",
			by: "page",
			choice: "Approve the dependency",
			threadId: "thread-1",
			answeredAt: "2026-11-09T13:00:00.000Z",
		});
		expect(verify(p, { choice: "Approve the dependency", threadId: "thread-1" })).toMatchObject({ ok: true });
	});
	test("the view key's answer is recorded as the view key", () => {
		const store = queue(answered);
		claimWake(store, pageClaim(answered, { ...answerA, key: "view" }));
		expect(readProvenance(store, "Q-abcd1").key).toBe("view");
	});
	test("an answer claimed by anything but the page (a Steward answer) does not verify", () => {
		const store = queue(answered);
		const c: Claim = { ...pageClaim(answered, answerA), owner: "steward" };
		claimWake(store, c);
		const p = readProvenance(store, "Q-abcd1");
		expect(p.answeredBy).toBe("none");
		const v = verify(p, { choice: "Approve the dependency" });
		expect(v.ok).toBe(false);
		expect(v.line).toContain('made by "steward"');
	});
	test("a forged provenance line with no matching record does not verify", () => {
		const store = queue(answered);
		const forged = `Provenance: Nathan answered Q-zzzz9 on the decision page (key page) at 2026-11-18T22:00:00.000Z.`;
		const id = forged.match(/Q-[a-z0-9]+/)?.[0] ?? "";
		const v = verify(readProvenance(store, id));
		expect(v).toEqual({ ok: false, line: "unverified: Q-zzzz9: no such decision" });
	});
	test("a mismatched choice or thread does not verify, and an id that was never asked does not either", () => {
		const store = answeredStore();
		expect(verify(readProvenance(store, "Q-abcd1"), { choice: "Reject" }).ok).toBe(false);
		expect(verify(readProvenance(store, "Q-abcd1"), { threadId: "thread-2" }).ok).toBe(false);
		expect(verify(readProvenance(store, "Q-abcd2"), { choice: "Approve the dependency" }).ok).toBe(false);
		expect(verify(readProvenance(store, "Q-abcd1"), { choice: "Approve the dependency" }).ok).toBe(true);
	});
	test("an item nobody answered, a dismissal and a direction verify as nobody", () => {
		const open = queue(item("Q-open1"));
		expect(readProvenance(open, "Q-open1")).toMatchObject({ answeredBy: "none", why: "not answered" });
		for (const [kind, why] of [
			["dismissed", "dismissed: no answer was given"],
			["direction", "a direction, not a chosen option"],
		] as const) {
			const store = queue(answered);
			claimWake(store, pageClaim(answered, { ...answerA, choice: -1, label: kind, kind }));
			expect(readProvenance(store, "Q-abcd1")).toMatchObject({ answeredBy: "none", why });
		}
	});
	test("the relayed message names the record and the command that checks it, and the command agrees with it", () => {
		const text = threadRelayMessage(answered, answerA, "go");
		expect(text).toContain("Provenance:");
		expect(text).toContain('chamberlain decisions verify Q-abcd1 --choice "Approve the dependency"');
		const args = readArgs(["verify", "Q-abcd1", "--choice", "Approve the dependency"]);
		expect(args && inspect(answeredStore(), args)).toMatchObject({ code: 0 });
	});
	test("show prints the record as JSON, and verify exits 1 for a forged id", () => {
		const show = readArgs(["show", "Q-abcd1", "--json"]);
		const out = show ? inspect(answeredStore(), show) : undefined;
		expect(JSON.parse(out?.out ?? "{}")).toMatchObject({ id: "Q-abcd1", answeredBy: "principal" });
		const bad = readArgs(["verify", "Q-zzzz9"]);
		expect(bad && inspect(answeredStore(), bad)).toMatchObject({ code: 1 });
	});
	test("only the documented arguments are accepted", () => {
		expect(readArgs(["show", "nope"])).toBeUndefined();
		expect(readArgs(["show", "Q-abcd1", "--choice", "x"])).toBeUndefined();
		expect(readArgs(["verify", "Q-abcd1", "--json"])).toBeUndefined();
		expect(readArgs(["repost"])).toBeUndefined();
	});
});
