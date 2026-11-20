import { describe, expect, test } from "bun:test";
import { assistant, measure, row, session } from "../../testing/core-steward-health-fixtures.ts";

/**
 * A HAND OFF fired at 181k context only because the Steward's own reads of its transcript reached the limit (3): the reads the hand-off,
 * a compaction recovery or the wake's own delivery-id repeat check make were counted as wear. Those no longer count; an ordinary lookup does.
 */
const T = "2026-11-18T12:00:00Z";
const user = (text: string) => row({ type: "user", timestamp: T, message: { role: "user", content: text } });
const toolResult = () =>
	row({
		type: "user",
		timestamp: T,
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] },
	});
const boundary = () => row({ type: "system", subtype: "compact_boundary", timestamp: T });
const wake = (id: string, kind = "note") =>
	user(
		`[chamberlain] ${kind}: a thread reported.\ndelivery id: ${id} (the same id again is a repeat: do not act on it twice)`,
	);
const grep = (id: string, what: string) => ({
	type: "tool_use",
	id,
	name: "Bash",
	input: { command: `grep -c "${what}" /home/x/.claude/projects/p/${session}.jsonl` },
});
const reads = (tag: string, what = "b9cde25") => [grep(`${tag}1`, what), grep(`${tag}2`, what), grep(`${tag}3`, what)];
const AT_181K = 181_000;

describe("self-reads: what counts as wear", () => {
	test("must fire: three ordinary lookups in an ordinary wake still hand off", async () => {
		const h = await measure([wake("note:1"), assistant(AT_181K, reads("a"))], session);
		expect(h.selfReads).toBe(3);
		expect(h.verdict).toBe("HAND OFF");
	});

	test("must fire: tool results between the reads do not hide them, and a second ordinary wake does not reset the count", async () => {
		const h = await measure(
			[
				wake("note:1"),
				assistant(10, [grep("a1", "x")]),
				toolResult(),
				wake("note:2"),
				assistant(AT_181K, [grep("a2", "y"), grep("a3", "z")]),
			],
			session,
		);
		expect(h.selfReads).toBe(3);
		expect(h.verdict).toBe("HAND OFF");
	});

	test("must not fire: the hand-off's own reads never count", async () => {
		const h = await measure(
			[
				user(
					"[chamberlain] steward-handoff: the Steward has slipped.\ndelivery id: steward-handoff:s1 (the same id again is a repeat)",
				),
				assistant(AT_181K, reads("h")),
			],
			session,
		);
		expect(h.selfReads).toBe(0);
		expect(h.verdict).toBe("COMPACT");
	});

	test("must not fire: looking up the wake's own delivery id for a repeat never counts", async () => {
		const h = await measure(
			[wake("sweep:1794940676968"), assistant(AT_181K, reads("d", "sweep:1794940676968"))],
			session,
		);
		expect(h.selfReads).toBe(0);
		expect(h.verdict).toBe("COMPACT");
	});

	test("must not fire: reads in the two turns after a compaction (recovery) never count; the third turn's do", async () => {
		const recovered = await measure(
			[
				boundary(),
				user("This session is being continued from a previous conversation."),
				assistant(10, reads("r1")),
				wake("note:1"),
				assistant(AT_181K, reads("r2")),
			],
			session,
		);
		expect(recovered.selfReads).toBe(0);
		expect(recovered.verdict).toBe("COMPACT");
		const later = await measure(
			[
				boundary(),
				user("This session is being continued from a previous conversation."),
				wake("note:1"),
				wake("note:2"),
				assistant(AT_181K, reads("r3")),
			],
			session,
		);
		expect(later.selfReads).toBe(3);
		expect(later.verdict).toBe("HAND OFF");
	});

	test("a delivery id of another wake does not excuse a lookup, and the rest of the signals are untouched", async () => {
		const h = await measure([wake("note:1"), assistant(AT_181K, reads("o", "note:2"))], session);
		expect(h.selfReads).toBe(3);
		expect(h.verdict).toBe("HAND OFF");
	});
});

describe("self-reads: harness meta rows are transparent", () => {
	// The shape the repo's own transcript fixture uses (src/core/fixtures/steward-tokens.jsonl): the skill's expansion of a wake, flagged isMeta.
	const meta = () =>
		row({
			type: "user",
			isMeta: true,
			timestamp: T,
			message: {
				role: "user",
				content: [
					{
						type: "text",
						text: "Handle this wake as your hand-off says. A wake carries a delivery id (its last line, `delivery id: ...`).",
					},
				],
			},
		});

	test("must not fire: a meta row after the hand-off wake does not end the hand-off turn", async () => {
		const h = await measure(
			[
				user(
					"[chamberlain] steward-handoff: the Steward has slipped.\ndelivery id: steward-handoff:s1 (the same id again is a repeat)",
				),
				meta(),
				assistant(AT_181K, reads("m")),
			],
			session,
		);
		expect(h.selfReads).toBe(0);
		expect(h.verdict).toBe("COMPACT");
	});

	test("must not fire: a meta row after a wake does not replace its delivery id, so the repeat check still does not count", async () => {
		const h = await measure(
			[wake("sweep:1794940676968"), meta(), assistant(AT_181K, reads("d", "sweep:1794940676968"))],
			session,
		);
		expect(h.selfReads).toBe(0);
	});

	test("must not fire: a meta row uses up none of the two recovery turns after a compaction", async () => {
		const h = await measure(
			[
				boundary(),
				user("This session is being continued from a previous conversation."),
				meta(),
				wake("note:1"),
				assistant(AT_181K, reads("r")),
			],
			session,
		);
		expect(h.selfReads).toBe(0);
		expect(h.verdict).toBe("COMPACT");
	});

	test("must fire: a meta row does not hide ordinary lookups", async () => {
		const h = await measure([wake("note:1"), meta(), assistant(AT_181K, reads("o"))], session);
		expect(h.selfReads).toBe(3);
		expect(h.verdict).toBe("HAND OFF");
	});
});
