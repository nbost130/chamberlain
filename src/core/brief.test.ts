import { describe, expect, test } from "bun:test";
import { stewardBrief, type BriefInput } from "./brief.ts";

const base: BriefInput = {
	mode: "test",
	repo: "/opt/chamberlain",
	state: "/home/u/.state/chamberlain",
	principal: "Ada",
	rights: "- DECIDE MYSELF: merge conflicts",
	rulings: '- R1 (2026-11-01): "you can handle all merge conflicts" -> merge conflicts are the Steward\'s',
	operatingRules: "Use timeout, not gtimeout.",
	afk: { enteredAt: "2026-11-02T03:46:27Z", words: "keep things moving" },
	environments: [{ name: "main" }, { name: "laptop", environmentId: "laptop-id", mayBeOffline: true }],
	predecessor: "old-thread",
};

describe("stewardBrief", () => {
	test("carries rights and rulings verbatim", () => {
		const b = stewardBrief(base);
		expect(b).toContain(base.rights);
		expect(b).toContain(base.rulings);
	});
	test("carries the operating rules", () => {
		expect(stewardBrief(base)).toContain("Use timeout, not gtimeout.");
		expect(stewardBrief({ ...base, operatingRules: "" })).not.toContain("Operating rules");
	});
	test("names the principal wherever it speaks of them", () => {
		const b = stewardBrief(base);
		expect(b).toContain("You run Ada's agent threads");
		expect(b).toContain("It waits for Ada on the rulings page");
		expect(b).toContain("Decision rights (Ada's standing rules, verbatim)");
	});
	test("the backend's own sentences come from its adapter's notes, and are neutral without them", () => {
		const plain = stewardBrief(base);
		expect(plain).not.toContain("t3_");
		expect(plain).toContain("Otherwise read the end of the thread with your own tools.");
		expect(plain).toContain("Every server the daemon watches:");
		const notes = { threads: "pane threads", server: "workspace", readThread: "run `peek <id>`", cardGuard: ", so `ack` stays off it.", reachIntro: "Reach a workspace with `ws`:", reachOutro: "Fallback: `wsx`." };
		const b = stewardBrief({ ...base, notes });
		for (const x of ["You run Ada's pane threads", "watches every workspace", "Otherwise run `peek <id>`.", "so `ack` stays off it.", "Reach a workspace with `ws`:", "Fallback: `wsx`."]) expect(b).toContain(x);
	});
	test("without a principalName it speaks of the operator", () => {
		const b = stewardBrief({ ...base, principal: undefined });
		expect(b).toContain("You run the operator's agent threads");
		expect(b).not.toContain("Ada");
	});
	test("test mode confines the Steward to SANDBOX threads and forbids cards", () => {
		const b = stewardBrief(base);
		expect(b).toContain("Mode: TEST");
		expect(b).toContain("`SANDBOX`");
		expect(b).toContain("Do not call `AskUserQuestion`");
	});
	test("live mode carries no test restriction", () => {
		const b = stewardBrief({ ...base, mode: "live" });
		expect(b).toContain("Mode: LIVE");
		expect(b).not.toContain("SANDBOX");
	});
	test("tells the Steward it is permanent and to write things down", () => expect(stewardBrief(base)).toContain("You are permanent"));
	test("points at the ledgers instead of copying them, by absolute path", () => {
		const b = stewardBrief(base);
		expect(b).toContain("decisions-thread");
		expect(b).toContain("Never call `AskUserQuestion` in this thread");
		expect(b).toContain("bun /opt/chamberlain/src/core/afk.ts held");
		expect(b).toContain("afk.ts close");
		expect(b).toContain("afk.ts note <id>");
		expect(b).toContain("An FYI is never a hold");
		expect(b).toContain("--pr <owner/repo#n>");
		expect(b).toContain("You create no sweep task");
		expect(b).toContain("bun /opt/chamberlain/src/core/decided.ts list 15");
		expect(b).toContain("bun /opt/chamberlain/src/core/afk.ts status");
		expect(b).toContain("so 0 is the first option");
	});
	test("names the environment id for remote machines and none for this one", () => {
		const b = stewardBrief(base);
		expect(b).toContain("laptop: pass `environmentId: laptop-id`");
		expect(b).toContain("main: this server");
	});
	test("names the predecessor and warns off reading it", () => {
		expect(stewardBrief(base)).toContain("Do not read its history");
		expect(stewardBrief({ ...base, predecessor: undefined })).not.toContain("Predecessor");
	});
	test("flags a servers.json with no local server", () => {
		expect(stewardBrief({ ...base, environments: [{ name: "laptop", environmentId: "x" }] })).toContain("No environment");
	});
	test("carries nothing from a private setup", () => {
		expect(stewardBrief(base)).not.toMatch(/bors|gate-check|breaker/i);
	});
});
