/** web, continued: see web.test.ts for the overview. */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { getQuestion, questionStates } from "../core/items/questions.ts";
import { propose, readRulings } from "../core/ops/rulings.ts";
import { openStore } from "../core/store/sqlite-store.ts";
import { dbPath } from "../core/store/store.ts";
import { fetchWake } from "../testing/wake.ts";
import { useWebWebFixtures } from "../testing/web-web-fixtures.ts";

const { dirs, item, setup } = useWebWebFixtures(fetchWake);

describe("schema versions at server start", () => {
	const start = (setupFiles: (conf: string, state: string) => void) => {
		const root = mkdtempSync(`${tmpdir()}/chamberlain-srv-`);
		dirs.push(root);
		const conf = `${root}/conf`,
			state = `${root}/state`;
		mkdirSync(conf, { mode: 0o700 });
		mkdirSync(state);
		const port = 40000 + Math.floor(Math.random() * 20000);
		writeFileSync(`${conf}/web.json`, JSON.stringify({ host: "127.0.0.1", port }), { mode: 0o600 });
		setupFiles(conf, state);
		const p = Bun.spawn([process.execPath, new URL("./server.ts", import.meta.url).pathname, "--test"], {
			env: {
				...process.env,
				CHAMBERLAIN_CONF: conf,
				CHAMBERLAIN_STATE: state,
				CHAMBERLAIN_T3_STATE_DB: "/nonexistent/statev2.sqlite",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		return { p, conf, state };
	};
	test("a new install creates its database and starts", async () => {
		const { p, state } = start(() => {});
		try {
			const reader = p.stdout.getReader();
			let out = "";
			const deadline = Date.now() + 10_000;
			while (!out.includes("decision queue on") && Date.now() < deadline) {
				const { value, done } = await reader.read();
				if (done) break;
				out += new TextDecoder().decode(value);
			}
			expect(out).toContain("decision queue on");
			expect(existsSync(dbPath(state))).toBe(true);
		} finally {
			p.kill();
			await p.exited;
		}
	});
	test("a config file from a newer Chamberlain stops the server with exit code 3 and a clear reason", async () => {
		const { p } = start((conf) =>
			writeFileSync(`${conf}/settings.json`, JSON.stringify({ schemaVersion: 9 }), { mode: 0o600 }),
		);
		const err = await new Response(p.stderr).text();
		expect(await p.exited).toBe(3);
		expect(err).toContain("settings.json has schemaVersion 9");
		expect(err).toContain("newer Chamberlain");
	});
	test("a database from a newer Chamberlain stops the server with exit code 3 and a clear reason", async () => {
		const { p } = start((_c, state) => {
			const store = openStore(dbPath(state));
			store.close();
			const raw = new Database(dbPath(state));
			raw.run("INSERT INTO migrations (version, name, applied_at) VALUES (99, 'from the future', 'now')");
			raw.close();
		});
		const err = await new Response(p.stderr).text();
		expect(await p.exited).toBe(3);
		expect(err).toContain("migration 99");
		expect(err).toContain("newer Chamberlain");
	});
});

describe("rulings from the page", () => {
	test("no ruling is saved unless the box is checked", async () => {
		const s = setup();
		s.add(item("Q-abcd"));
		const before = readRulings(s.store).length;
		await s.post("/api/items/Q-abcd/answer", { choice: 0 });
		await s.app.idle();
		expect(readRulings(s.store)).toHaveLength(before);
		expect(s.posts[0]!.message).toContain("ruling: none saved");
	});
	test("a checked box creates the ruling in force with confirmed:true, and the wake says so", async () => {
		const s = setup();
		s.add(item("Q-abcd"));
		const r = await s.post("/api/items/Q-abcd/answer", {
			choice: 0,
			saveRuling: true,
			rulingWording: "Onboarding screens lead with a photo",
		});
		const { ruling } = (await r.json()) as { ruling: string };
		await s.app.idle();
		const saved = readRulings(s.store).find((x) => x.id === ruling)!;
		expect(saved.status).toBe("in-force");
		expect(saved.confirmed).toBe(true);
		expect(saved.decides).toBe("Onboarding screens lead with a photo");
		expect(saved.item).toBe("Q-abcd");
		expect(s.posts[0]!.message).toContain(`ruling: saved as ${ruling}, in force and confirmed by the operator`);
	});
	test("Accept all never saves a ruling, even with saveRuling sent", async () => {
		const s = setup();
		s.add(item("Q-abcd"));
		const before = readRulings(s.store).length;
		await s.post("/api/accept-all", { ids: ["Q-abcd"], saveRuling: true });
		await s.app.idle();
		expect(readRulings(s.store)).toHaveLength(before);
	});
	test("confirm, edit, only this once and retire on the rulings page", async () => {
		const s = setup();
		const { propose } = await import("../core/ops/rulings.ts");
		const p = propose(s.store, { words: "Approve (Recommended)", decides: "gates" });
		expect((await s.post(`/api/rulings/${p.id}/edit`, { decides: "gates like this" })).status).toBe(200);
		expect(readRulings(s.store).find((x) => x.id === p.id)!.status).toBe("proposed");
		expect((await s.post(`/api/rulings/${p.id}/confirm`, {})).status).toBe(200);
		expect(readRulings(s.store).find((x) => x.id === p.id)).toMatchObject({
			status: "in-force",
			confirmed: true,
			decides: "gates like this",
		});
		expect((await s.post("/api/rulings/R1/once", {})).status).toBe(200);
		expect(readRulings(s.store).find((x) => x.id === "R1")).toMatchObject({
			status: "retired",
			retiredHow: "only this once",
		});
		const view = (await (await s.get("/api/rulings")).json()) as { rulings: { id: string }[] };
		expect(view.rulings.map((x) => x.id)).toContain("R1");
	});
	test("a ruling saved from a question with proposedExpires carries the expiry, and the page marks it expired when the clock passes it", async () => {
		let t = Date.parse("2026-11-13T12:00:00Z");
		const s = setup({ now: () => t });
		s.add(item("Q-abcd", { proposedExpires: "2026-11-20" }));
		const { ruling } = (await (await s.post("/api/items/Q-abcd/answer", { choice: 0, saveRuling: true })).json()) as {
			ruling: string;
		};
		await s.app.idle();
		expect(readRulings(s.store).find((x) => x.id === ruling)).toMatchObject({
			status: "in-force",
			expires: "2026-11-20",
		});
		const inForceCount = async () => ((await (await s.get("/api/queue")).json()) as { inForce: number }).inForce;
		const view = async () =>
			((await (await s.get("/api/rulings")).json()) as { rulings: { id: string; expired: boolean }[] }).rulings;
		expect(await inForceCount()).toBe(2);
		expect((await view()).find((r) => r.id === ruling)!.expired).toBe(false);
		t = Date.parse("2026-11-21T00:00:00Z");
		expect(await inForceCount()).toBe(1);
		expect((await view()).find((r) => r.id === ruling)).toMatchObject({ expired: true, status: "in-force" });
		expect((await view()).find((r) => r.id === "R1")!.expired).toBe(false);
		// An expired ruling cannot be confirmed from the page.
		const c = await s.post(`/api/rulings/${ruling}/confirm`, {});
		expect(c.status).toBe(400);
		expect(((await c.json()) as { error: string }).error).toContain("expired on 2026-11-20");
	});
	test("saving a ruling whose proposed expiry has passed is refused before anything is claimed", async () => {
		let t = Date.parse("2026-11-13T12:00:00Z");
		const s = setup({ now: () => t });
		s.add(item("Q-abcd", { proposedExpires: "2026-11-14" }));
		t = Date.parse("2026-11-15T00:00:00Z");
		const before = readRulings(s.store).length;
		const r = await s.post("/api/items/Q-abcd/answer", { choice: 0, saveRuling: true });
		expect(r.status).toBe(400);
		expect(((await r.json()) as { error: string }).error).toContain("expired on 2026-11-14");
		expect(readRulings(s.store)).toHaveLength(before);
		expect(getQuestion(s.store, "Q-abcd")!.status).toBe("open");
		// Answering without saving a ruling still works.
		expect((await s.post("/api/items/Q-abcd/answer", { choice: 0 })).status).toBe(200);
	});
	test("saving a ruling whose stored proposed expiry does not exist is refused with that reason, before anything is claimed", async () => {
		const s = setup({ now: () => Date.parse("2026-11-13T12:00:00Z") });
		s.add(item("Q-abcd", { proposedExpires: "2027-02-30T09:00:00Z" }));
		const before = readRulings(s.store).length;
		const r = await s.post("/api/items/Q-abcd/answer", { choice: 0, saveRuling: true });
		expect(r.status).toBe(400);
		expect(((await r.json()) as { error: string }).error).toContain(
			'"2027-02-30T09:00:00Z" is not a real date and time',
		);
		expect(readRulings(s.store)).toHaveLength(before);
		expect(getQuestion(s.store, "Q-abcd")!.status).toBe("open");
	});
	test("two questions saved with the same wording and choice give one ruling, and both answers cite it", async () => {
		const s = setup();
		s.add(item("Q-abcd"));
		s.add(item("Q-efgh"));
		const a = (await (await s.post("/api/items/Q-abcd/answer", { choice: 0, saveRuling: true })).json()) as {
			ruling: string;
		};
		const b = (await (await s.post("/api/items/Q-efgh/answer", { choice: 0, saveRuling: true })).json()) as {
			ruling: string;
		};
		await s.app.idle();
		expect(b.ruling).toBe(a.ruling);
		expect(readRulings(s.store).filter((x) => x.decides === "Lead with a photo")).toHaveLength(1);
		// Both answers reach the Steward, alone or in one digest, or still held for its next idle moment (hold.ts).
		const written = [...s.posts.map((p) => p.message), ...s.store.wakes.held().map((h) => h.message)].join("\n");
		expect(written.split(`saved as ${a.ruling}`)).toHaveLength(3);
	});
	test("saving a ruling the Steward already proposed in the same words puts that proposal in force, not a second ruling", async () => {
		const s = setup();
		const p = propose(s.store, { words: "A · One", decides: "Lead with a photo" });
		s.add(item("Q-abcd"));
		const r = (await (await s.post("/api/items/Q-abcd/answer", { choice: 0, saveRuling: true })).json()) as {
			ruling: string;
		};
		await s.app.idle();
		expect(r.ruling).toBe(p.id);
		expect(readRulings(s.store).find((x) => x.id === p.id)).toMatchObject({ status: "in-force", confirmed: true });
		expect(readRulings(s.store).filter((x) => x.decides === "Lead with a photo")).toHaveLength(1);
	});
	test("a refused second answer saves no ruling, and does not promote a held proposal", async () => {
		const s = setup();
		const p = propose(s.store, { words: "A · One", decides: "Lead with a photo" });
		s.add(item("Q-abcd"));
		expect((await s.post("/api/items/Q-abcd/answer", { choice: 1 })).status).toBe(200);
		const r = await s.post("/api/items/Q-abcd/answer", { choice: 0, saveRuling: true });
		expect(r.status).toBe(409);
		expect(readRulings(s.store).find((x) => x.id === p.id)!.status).toBe("proposed");
	});
	test("the rulings page counts citations by ID from the decision log", async () => {
		const s = setup();
		for (const d of [
			{ t: "2026-11-09T01:00:00Z", thread: "a", decision: "took it", ruling: "R1", rulingIds: ["R1"], ref: null },
			{ t: "2026-11-09T02:00:00Z", thread: "b", decision: "again", ruling: "R1: same", rulingIds: ["R1"], ref: null },
			{ t: "2026-11-09T03:00:00Z", thread: "c", decision: "free", ruling: "merge conflicts", ref: null },
		])
			s.store.decisions.append(d);
		const view = (await (await s.get("/api/rulings")).json()) as {
			rulings: { id: string; cited: number; recent: { decision: string }[] }[];
		};
		expect(view.rulings.find((r) => r.id === "R1")).toMatchObject({ cited: 2 });
		expect(view.rulings.find((r) => r.id === "R1")!.recent[0]!.decision).toBe("again");
	});
});

describe("Accept all recommendations", () => {
	test("never includes an only-you item, a secret or one with no recommendation", async () => {
		const s = setup();
		s.add(item("Q-only", { kind: "only-you" }));
		s.add(item("Q-secr", { secret: true }));
		s.add(item("Q-norc", { recommended: undefined }));
		s.add(item("Q-good"));
		const r = (await (await s.post("/api/accept-all", { ids: ["Q-only", "Q-secr", "Q-norc", "Q-good"] })).json()) as {
			answered: string[];
			skipped: { id: string }[];
		};
		await s.app.idle();
		expect(r.answered).toEqual(["Q-good"]);
		expect(r.skipped.map((x) => x.id)).toEqual(["Q-only", "Q-secr", "Q-norc"]);
		const st = questionStates(s.store);
		expect(st.get("Q-only")!.status).toBe("open");
		expect(s.posts.map((p) => p.deliveryId)).toEqual(["answer:item:Q-good"]);
		expect(s.posts[0]!.message).toContain("(accepted with every recommendation)");
	});
});
