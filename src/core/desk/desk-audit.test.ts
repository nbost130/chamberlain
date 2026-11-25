import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { noAlert } from "../../testing/alert.ts";
import { createFakeAdapter } from "../../testing/fake-adapter.ts";
import { testRelayLock } from "../../testing/lock.ts";
import { memStore } from "../../testing/store.ts";
import type { DeskTurn, ReadDeskTurns } from "../adapter/adapter-desk.ts";
import { createEngine } from "../engine/engine.ts";
import type { Store } from "../store/store.ts";
import { deskAuditPass } from "./desk-audit.ts";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const bash = (command: string) => ({ tool: "Bash", input: { command } });
const turn = (id: string, over: Partial<DeskTurn> = {}): DeskTurn => ({
	id,
	at: `2026-01-01T11:00:0${id.slice(-1)}.000Z`,
	items: 3,
	ran: [bash("ok")],
	refused: 0,
	unreadable: 0,
	...over,
});

function rig(turns: () => DeskTurn[] | undefined, store: Store = memStore()) {
	const alarms: string[][] = [];
	const logged: { event: string; [k: string]: unknown }[] = [];
	const asked: Parameters<ReadDeskTurns>[0][] = [];
	const pass = () =>
		deskAuditPass({
			store,
			read: (span) => {
				asked.push(span);
				const rows = turns()?.filter((t) => t.at > span.after.at || (t.at === span.after.at && t.id > span.after.id));
				return rows && { turns: rows.slice(0, span.limit), env: { DESK_LOG_DIRS: "/logs" } };
			},
			check: (call, env) => {
				if (env.DESK_LOG_DIRS !== "/logs") throw Error("no environment");
				if (call.input.command === "throws") throw Error("secret-text");
				return call.input.command === "ok";
			},
			alarm: (...a) => alarms.push(a),
			log: (event, data) => logged.push({ event, ...data }),
			now: () => NOW,
		});
	return { store, alarms, logged, asked, pass };
}
const started = (turns: () => DeskTurn[] | undefined) => {
	const r = rig(turns);
	r.store.state.set("desk-audit", { at: "2026-01-01T10:00:00.000Z", id: "" });
	return r;
};

test("the first pass judges nothing that was there before, and later ones leave a turn time to settle", () => {
	const r = rig(() => [turn("t1", { ran: [bash("secret-text")] })]);
	r.pass();
	expect(r.asked).toEqual([]);
	r.pass();
	expect(r.asked[0]).toEqual({
		after: { at: "2026-01-01T12:00:00.000Z", id: "" },
		until: "2026-01-01T11:58:00.000Z",
		limit: 20,
	});
	expect(r.alarms).toEqual([]);
});

test("a call that ran and would be refused raises one alarm for its turn, with counts and no text", () => {
	const bad = [bash("secret-text"), bash("ok"), bash("throws"), { tool: "Write", input: {} }];
	const r = started(() => [turn("t1", { ran: bad }), turn("t2"), turn("t3", { ran: [], refused: 4 })]);
	r.pass();
	expect(r.alarms).toHaveLength(1);
	expect(r.alarms[0]?.[0]).toBe("desk-audit:t1");
	expect(r.alarms[0]?.[2]).toContain("3 of 4 calls");
	expect(JSON.stringify([r.alarms, r.logged])).not.toContain("secret-text");
	expect(r.logged.map(({ ran, outside, refused }) => ({ ran, outside, refused }))).toEqual([
		{ ran: 4, outside: 3, refused: 0 },
		{ ran: 1, outside: 0, refused: 0 },
		{ ran: 0, outside: 0, refused: 4 },
	]);
});

test("a turn with no records, or some that cannot be replayed, is never called complete", () => {
	const r = started(() => [turn("t1", { items: 0, ran: [] }), turn("t2", { unreadable: 2 }), turn("t3")]);
	r.pass();
	expect(r.logged.map((l) => l.complete)).toEqual([false, false, true]);
	expect(r.alarms).toEqual([]);
});

test("each turn is judged once, across passes and a restart", () => {
	const turns = [turn("t1", { ran: [bash("no")] }), turn("t2", { at: "2026-01-01T11:00:01.000Z", ran: [bash("no")] })];
	const r = started(() => turns);
	r.pass();
	r.pass();
	rig(() => turns, r.store).pass();
	expect(r.alarms.map((a) => a[0])).toEqual(["desk-audit:t1", "desk-audit:t2"]);
	expect(r.logged).toHaveLength(2);
});

test("a record that cannot be read is said once, keeps its place, and is read when it returns", () => {
	let rows: DeskTurn[] | undefined;
	const r = started(() => rows);
	r.pass();
	r.pass();
	expect(r.logged).toEqual([{ event: "desk-audit-unavailable" }]);
	rows = [turn("t1")];
	r.pass();
	rows = undefined;
	r.pass();
	expect(r.logged.map((l) => l.event)).toEqual(["desk-audit-unavailable", "desk-audited", "desk-audit-unavailable"]);
});

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const f of cleanup.splice(0)) await f();
});

test("the engine audits the desk each housekeeping pass, and a failing read never stops the pass", async () => {
	const root = mkdtempSync(`${tmpdir()}/desk-audit-`);
	cleanup.push(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(`${root}/conf`, { mode: 0o700 });
	writeFileSync(`${root}/conf/decision-rights.md`, "ask", { mode: 0o600 });
	const store = memStore();
	store.state.set("desk-audit", { at: "2026-01-01T10:00:00.000Z", id: "" });
	const fake = createFakeAdapter();
	let fail = true;
	const lane = fake.alertDesk as { turns?: ReadDeskTurns };
	lane.turns = () => {
		if (fail) throw Error("broken");
		return { turns: [turn("t1", { ran: [bash("no")] })], env: {} };
	};
	const logged: string[] = [];
	const engine = createEngine({
		conf: `${root}/conf`,
		lock: testRelayLock(store),
		store,
		alert: noAlert,
		housekeeping: true,
		servers: [{ server: { name: "fake", adapter: "fake" }, adapter: fake }],
		log: (event, data) => logged.push(event === "alarm" ? `alarm ${data?.key}` : event),
		timing: { debounceMs: 5, lagMs: 5, quietMs: 5, tickMs: 3_600_000 },
		deskCheck: () => false,
	});
	cleanup.push(() => engine.stop());
	void engine.start();
	await engine.tick();
	expect(logged).toContain("desk-audit-error");
	fail = false;
	await engine.tick();
	expect(logged).toContain("desk-audited");
	expect(logged).toContain("alarm desk-audit:t1");
});
