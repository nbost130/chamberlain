import { afterEach } from "bun:test";
import { rmSync } from "node:fs";
import { appendHeld, HELD } from "../core/afk-held.ts";
import { type Question, questionStates } from "../core/questions.ts";
import type { Store } from "../core/store.ts";

/** Registers this suite's scratch cleanup for the test file that calls it, and returns its fixtures. */
export function useCoreSnoozeFixtures() {
	const NOW = Date.parse("2026-11-14T12:00:00.000Z");

	const HOUR = 3_600_000;

	const iso = (ms: number) => new Date(ms).toISOString();

	const dirs: string[] = [];

	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});

	const question = (id: string, over: Partial<Question> = {}): Question => ({
		id,
		kind: "product",
		title: `Which launch plan do we ship for ${id}`,
		context: "",
		options: [{ label: "Plan A" }, { label: "Plan B" }],
		recommended: 0,
		thread: "Launch thread",
		server: "main",
		threadId: "thread-1",
		createdAt: "2026-11-14T08:00:00.000Z",
		...over,
	});

	const hold = (store: Store, id: string) =>
		appendHeld(
			store,
			{ thread: "Launch thread", what: `waits on a launch plan for ${id}`, item: id },
			new Date(NOW - HOUR),
		);

	const holdNotes = (store: Store, hid: string) =>
		((store.items.get(HELD, hid)?.payload.notes as { text: string }[] | undefined) ?? []).map((n) => n.text);

	const stateOf = (store: Store, id: string, now = NOW) => questionStates(store, now).get(id)!;

	return { NOW, HOUR, iso, dirs, question, hold, holdNotes, stateOf };
}
