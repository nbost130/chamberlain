import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { noAlert } from "../../testing/alert.ts";
import { createFakeAdapter } from "../../testing/fake-adapter.ts";
import { testRelayLock } from "../../testing/lock.ts";
import { memStore } from "../../testing/store.ts";
import type { DeskTurn, DeskTurnRef, DeskTurns } from "../adapter/adapter-desk.ts";
import { createEngine } from "../engine/engine.ts";
import type { Store } from "../store/store.ts";
import { deskAuditPass } from "./desk-audit.ts";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const bash = (command: string) => ({ tool: "Bash", input: { command } });
type Fixture = DeskTurnRef & DeskTurn;
const turn = (id: string, over: Partial<Fixture> = {}): Fixture => ({
	id,
	at: `2026-01-01T11:00:0${id.slice(-1)}.000Z`,
	items: 3,
	rev: "3",
	ran: [bash("ok")],
	refused: 0,
	unreadable: 0,
	...over,
});

function rig(fixtures: () => Fixture[] | undefined, store: Store = memStore()) {
	const alarms: string[][] = [];
	const logged: { event: string; [k: string]: unknown }[] = [];
	const spans: object[] = [];
	const unreadable = new Set<string>();
	const reads: string[] = [];
	let checks = 0;
	const clock = { t: NOW };
	const pass = () =>
		deskAuditPass({
			store,
			turns: {
				list: (span) => {
					spans.push(span);
					return fixtures()?.filter((t) => t.at > span.after && t.at <= span.until);
				},
				read: ({ id }) => {
					reads.push(id);
					const found = unreadable.has(id) ? undefined : fixtures()?.find((t) => t.id === id);
					return found && { ran: found.ran, refused: found.refused, unreadable: found.unreadable };
				},
				env: () => ({ DESK_LOG_DIRS: "/logs" }),
			},
			check: (env) => {
				checks++;
				return (call) => {
					if (env.DESK_LOG_DIRS !== "/logs") throw Error("no environment");
					if (call.input.command === "throws") throw Error("secret-text");
					return call.input.command === "ok";
				};
			},
			alarm: (...a) => alarms.push(a),
			log: (event, data) => logged.push({ event, ...data }),
			now: () => clock.t,
		});
	return { store, alarms, logged, spans, reads, unreadable, clock, pass, checks: () => checks };
}
const started = (fixtures: () => Fixture[] | undefined) => {
	const r = rig(fixtures);
	r.store.state.set("desk-audit", { since: "2026-01-01T10:00:00.000Z", judged: {} });
	return r;
};

test("the first pass judges nothing that was there before, and later ones leave a turn time to settle", () => {
	const r = rig(() => [turn("t1", { ran: [bash("secret-text")] })]);
	r.pass();
	expect(r.spans).toEqual([]);
	r.clock.t += 60_000;
	r.pass();
	expect(r.spans).toEqual([{ after: "2026-01-01T12:00:00.000Z", until: "2026-01-01T11:59:00.000Z", limit: 1_000 }]);
	expect(r.alarms).toEqual([]);
});

test("a call that ran and would be refused raises one alarm for its turn, with counts and no text", () => {
	const bad = [bash("secret-text"), bash("ok"), bash("throws"), { tool: "Write", input: {} }];
	const r = started(() => [turn("t1", { ran: bad }), turn("t2"), turn("t3", { ran: [], refused: 4 })]);
	r.pass();
	expect(r.alarms).toHaveLength(1);
	expect(r.alarms[0]?.[0]).toBe("desk-audit:t1");
	expect(r.alarms[0]?.[2]).toContain("3 of 4 calls");
	expect(JSON.stringify([r.alarms, r.logged, r.store.state.get("desk-audit")])).not.toContain("secret-text");
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

test("each turn is judged once, across passes and a restart, with the rules read again for each pass that judges", () => {
	const turns = [turn("t1", { ran: [bash("no")] })];
	const r = started(() => turns);
	r.pass();
	r.pass();
	const again = rig(() => turns, r.store);
	again.pass();
	expect(r.alarms).toHaveLength(1);
	expect([...r.reads, ...again.reads]).toEqual(["t1"]);
	expect(r.checks()).toBe(1);
	turns.push(turn("t2"));
	again.pass();
	expect(again.reads).toEqual(["t2"]);
	expect(again.checks()).toBe(1);
});

test("a turn or a record that appears late, behind what was already judged, is still judged", () => {
	const turns = [turn("t5")];
	const r = started(() => turns);
	r.pass();
	turns.unshift(turn("t1", { ran: [bash("no")] }));
	r.pass();
	expect(r.alarms.map((a) => a[0])).toEqual(["desk-audit:t1"]);
	turns[1] = turn("t5", { rev: "3 later", ran: [bash("ok"), bash("no")] });
	r.pass();
	expect(r.alarms.map((a) => a[0])).toEqual(["desk-audit:t1", "desk-audit:t5"]);
});

test("a saved state of another shape starts again from now, and does not stop the audit", () => {
	for (const old of [
		{ at: "2026-01-01T10:00:00.000Z", id: "x" },
		"x",
		7,
		{ since: "x" },
		{ since: "x", judged: null },
	]) {
		const r = rig(() => [turn("t1")]);
		r.store.state.set("desk-audit", old);
		r.pass();
		expect(r.store.state.get("desk-audit")).toEqual({ since: "2026-01-01T12:00:00.000Z", judged: {} });
	}
});

test("turns that cannot be read do not use up the place of one that can", () => {
	const r = started(() => ["t1", "t2", "t3", "t4"].map((id) => turn(id)));
	for (const id of ["t1", "t2", "t3"]) r.unreadable.add(id);
	r.pass();
	expect(Object.keys(r.store.state.get<{ judged: object }>("desk-audit")?.judged ?? {})).toEqual(["t4"]);
});

test("a pass reads a few turns, and the next ones take the rest", () => {
	const turns = Array.from({ length: 5 }, (_, i) => turn(`t${i + 1}`));
	const r = started(() => turns);
	r.pass();
	expect(r.reads).toEqual(["t1", "t2", "t3"]);
	r.pass();
	expect(r.reads).toEqual(["t1", "t2", "t3", "t4", "t5"]);
});

test("what was judged is forgotten once its turn is out of the window, and that turn is not read again", () => {
	const r = started(() => [turn("t1")]);
	r.pass();
	const judged = () => Object.keys(r.store.state.get<{ judged: object }>("desk-audit")?.judged ?? {});
	expect(judged()).toEqual(["t1"]);
	r.clock.t += 7 * 60 * 60_000;
	r.pass();
	expect(judged()).toEqual([]);
	expect(r.reads).toEqual(["t1"]);
});

test("turns that cannot be read are said once per outage, and read when they can be", () => {
	let rows: Fixture[] | undefined;
	const r = started(() => rows);
	r.pass();
	r.pass();
	expect(r.logged).toEqual([{ event: "desk-audit-unavailable" }]);
	rows = [turn("t1")];
	r.unreadable.add("t1");
	r.pass();
	expect(r.logged).toHaveLength(1);
	r.unreadable.clear();
	r.pass();
	rows = undefined;
	r.pass();
	expect(r.logged.map((l) => l.event)).toEqual(["desk-audit-unavailable", "desk-audited", "desk-audit-unavailable"]);
});

test("a listed turn that cannot be read is said once, and read later", () => {
	const r = started(() => [turn("t1")]);
	r.unreadable.add("t1");
	r.pass();
	r.pass();
	expect(r.logged).toEqual([{ event: "desk-audit-unavailable" }]);
	r.unreadable.clear();
	r.pass();
	expect(r.logged.map((l) => l.event)).toEqual(["desk-audit-unavailable", "desk-audited"]);
});

test("more turns than one list holds is said once, and what was listed is still judged", () => {
	const turns = Array.from({ length: 1_000 }, () => turn("t1"));
	const r = started(() => turns);
	r.pass();
	r.pass();
	expect(r.logged.map((l) => l.event)).toEqual([
		"desk-audit-unavailable",
		"desk-audited",
		"desk-audited",
		"desk-audited",
	]);
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
	store.state.set("desk-audit", { since: "2026-01-01T10:00:00.000Z", judged: {} });
	const fake = createFakeAdapter();
	let fail = true;
	const lane = fake.alertDesk as { turns?: DeskTurns };
	lane.turns = {
		list: () => {
			if (fail) throw Error("broken");
			return [{ id: "t1", at: "2026-01-01T11:00:00.000Z", items: 1, rev: "1" }];
		},
		read: () => ({ ran: [bash("no")], refused: 0, unreadable: 0 }),
		env: () => ({}),
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
		deskCheck: () => () => false,
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
