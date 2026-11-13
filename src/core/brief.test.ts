import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { authorityProblem } from "./private.ts";
import { loadBriefFragments, OPEN_WORK_HEADING, stewardBrief, withFragments, type BriefInput } from "./brief.ts";

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
	test("tells the Steward how to record a time-bound or replacing ruling, and that recording twice adds nothing", () => {
		const b = stewardBrief(base);
		expect(b).toContain("--expires <ISO date>");
		expect(b).toContain("--supersedes R32,R16");
		expect(b).toContain("recording the same words twice adds nothing");
		expect(b).toContain("proposedExpires?");
	});
	test("an expired ruling the section names is carried as given", () => {
		const rulings = `${base.rulings}\nExpired, NOT in force (do not act on them): R2 (expired 2026-11-20).`;
		expect(stewardBrief({ ...base, rulings })).toContain("Expired, NOT in force (do not act on them): R2 (expired 2026-11-20).");
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

describe("brief fragments", () => {
	// Explicit modes: the umask may be 002 (a user-private group), which would make brief.d 0775 and a fragment 0664, both refused.
	const conf = () => { const d = mkdtempSync(`${tmpdir()}/brief-d-`); mkdirSync(`${d}/brief.d`); chmodSync(`${d}/brief.d`, 0o755); return d; };
	const put = (d: string, name: string, text: string) => { writeFileSync(`${d}/brief.d/${name}`, text); chmodSync(`${d}/brief.d/${name}`, 0o644); };

	test("no brief.d is no fragments, and no warning", () => {
		const warned: string[] = [];
		expect(loadBriefFragments(mkdtempSync(`${tmpdir()}/brief-none-`), (m) => warned.push(m))).toEqual([]);
		expect(warned).toEqual([]);
	});

	test("regular .md files only, sorted by filename in byte order, each verbatim with its own headings", () => {
		const d = conf();
		put(d, "20-landing.md", "## Landing\n\n- Merge on green.\n");
		put(d, "10-repo.md", "# Repo procedure\n\n### Branches\n\n  - indented, kept\n");
		put(d, "B-upper.md", "upper sorts before lower in byte order\n");
		put(d, "a-lower.md", "lower\n");
		put(d, "é-accent.md", "a multibyte name sorts after ASCII\n");
		expect(loadBriefFragments(d, () => {})).toEqual([
			"# Repo procedure\n\n### Branches\n\n  - indented, kept",
			"## Landing\n\n- Merge on green.",
			"upper sorts before lower in byte order",
			"lower",
			"a multibyte name sorts after ASCII",
		]);
	});

	test("symlinks, other names and directories are ignored with a warning", () => {
		const d = conf();
		put(d, "10-real.md", "real\n");
		writeFileSync(`${d}/elsewhere.md`, "linked\n");
		symlinkSync(`${d}/elsewhere.md`, `${d}/brief.d/20-link.md`);
		put(d, "30-notes.txt", "not markdown\n");
		put(d, "40-backup.md~", "an editor backup\n");
		mkdirSync(`${d}/brief.d/50-dir.md`);
		const warned: string[] = [];
		expect(loadBriefFragments(d, (m) => warned.push(m))).toEqual(["real"]);
		expect(warned.length).toBe(4);
		for (const n of ["20-link.md", "30-notes.txt", "40-backup.md~", "50-dir.md"]) expect(warned.some((w) => w.includes(n))).toBe(true);
		expect(warned.find((w) => w.includes("20-link.md"))).toContain("symlink");
	});

	test("a brief.d that is not a directory is ignored with a warning", () => {
		const d = mkdtempSync(`${tmpdir()}/brief-file-`);
		writeFileSync(`${d}/brief.d`, "x");
		const warned: string[] = [];
		expect(loadBriefFragments(d, (m) => warned.push(m))).toEqual([]);
		expect(warned[0]).toContain("not a directory");
	});

	describe("fragments are authority: brief.d and each fragment must be the operator's and writable by no one else", () => {
		const me = process.geteuid!();
		test("a brief.d that is a symlink to a directory is refused with a warning, and the brief still comes out", () => {
			const d = mkdtempSync(`${tmpdir()}/brief-link-`);
			mkdirSync(`${d}/real`);
			writeFileSync(`${d}/real/10.md`, "linked in\n");
			symlinkSync(`${d}/real`, `${d}/brief.d`);
			const warned: string[] = [];
			expect(loadBriefFragments(d, (m) => warned.push(m))).toEqual([]);
			expect(warned).toHaveLength(1);
			expect(warned[0]).toContain(`${d}/brief.d`);
			expect(warned[0]).toContain("symlink");
		});
		for (const [mode, why] of [[0o775, "group-writable"], [0o757, "world-writable"], [0o777, "group- and world-writable"]] as const) {
			test(`a brief.d with mode ${mode.toString(8)} is refused: ${why}`, () => {
				const d = conf();
				put(d, "10.md", "x\n");
				chmodSync(`${d}/brief.d`, mode);
				const warned: string[] = [];
				expect(loadBriefFragments(d, (m) => warned.push(m))).toEqual([]);
				expect(warned).toHaveLength(1);
				expect(warned[0]).toContain(`${d}/brief.d`);
				expect(warned[0]).toContain(why);
			});
		}
		test("a brief.d not owned by the effective uid is refused", () => {
			const d = conf();
			put(d, "10.md", "x\n");
			const warned: string[] = [];
			expect(loadBriefFragments(d, (m) => warned.push(m), { euid: me + 1 })).toEqual([]);
			expect(warned[0]).toContain(`owned by uid ${me}, not ${me + 1}`);
		});
		test("a group- or world-writable fragment is skipped with a warning naming it; 0600 and 0644 fragments are used", () => {
			const d = conf();
			put(d, "10-private.md", "private\n");
			put(d, "20-readable.md", "readable\n");
			put(d, "30-group.md", "group\n");
			put(d, "40-world.md", "world\n");
			chmodSync(`${d}/brief.d/10-private.md`, 0o600);
			chmodSync(`${d}/brief.d/20-readable.md`, 0o644);
			chmodSync(`${d}/brief.d/30-group.md`, 0o664);
			chmodSync(`${d}/brief.d/40-world.md`, 0o646);
			const warned: string[] = [];
			expect(loadBriefFragments(d, (m) => warned.push(m))).toEqual(["private", "readable"]);
			expect(warned).toHaveLength(2);
			expect(warned[0]).toContain(`${d}/brief.d/30-group.md`);
			expect(warned[0]).toContain("group-writable");
			expect(warned[1]).toContain(`${d}/brief.d/40-world.md`);
			expect(warned[1]).toContain("world-writable");
		});
		test("the check itself: owner, kind and write bits, for a file and a directory", () => {
			const st = (o: { mode: number; uid?: number; file?: boolean; dir?: boolean; link?: boolean }) => ({ mode: o.mode, uid: o.uid ?? me, isFile: () => Boolean(o.file), isDirectory: () => Boolean(o.dir), isSymbolicLink: () => Boolean(o.link) });
			expect(authorityProblem(st({ mode: 0o100600, file: true }), "file", me)).toBeUndefined();
			expect(authorityProblem(st({ mode: 0o100644, file: true }), "file", me)).toBeUndefined();
			expect(authorityProblem(st({ mode: 0o40755, dir: true }), "directory", me)).toBeUndefined();
			expect(authorityProblem(st({ mode: 0o100644, file: true, uid: me + 7 }), "file", me)).toBe(`owned by uid ${me + 7}, not ${me}`);
			expect(authorityProblem(st({ mode: 0o100620, file: true }), "file", me)).toContain("group-writable");
			expect(authorityProblem(st({ mode: 0o100602, file: true }), "file", me)).toContain("world-writable");
			expect(authorityProblem(st({ mode: 0o120777, link: true }), "file", me)).toContain("symlink");
			expect(authorityProblem(st({ mode: 0o40700, dir: true }), "file", me)).toContain("not a regular file");
			expect(authorityProblem(st({ mode: 0o100600, file: true }), "directory", me)).toContain("not a directory");
		});
		test("a brief.d the operator can write but not read (0300) passes the check, gives no fragment, warns once, and the brief still builds", () => {
			const d = conf();
			put(d, "10.md", "x\n");
			chmodSync(`${d}/brief.d`, 0o300);
			const warned: string[] = [];
			let fragments: string[] = ["unset"];
			try { fragments = loadBriefFragments(d, (m) => warned.push(m)); } finally { chmodSync(`${d}/brief.d`, 0o755); }
			expect(fragments).toEqual([]);
			expect(warned).toHaveLength(1);
			expect(warned[0]).toContain(`${d}/brief.d`);
			expect(warned[0]).toContain("EACCES");
			expect(stewardBrief({ ...base, fragments })).toBe(stewardBrief(base));
		});
		test("a brief.d that can be listed but not searched (0600) skips each fragment with a warning naming it", () => {
			const d = conf();
			put(d, "10.md", "x\n");
			chmodSync(`${d}/brief.d`, 0o600);
			const warned: string[] = [];
			let fragments: string[] = ["unset"];
			try { fragments = loadBriefFragments(d, (m) => warned.push(m)); } finally { chmodSync(`${d}/brief.d`, 0o755); }
			expect(fragments).toEqual([]);
			expect(warned).toHaveLength(1);
			expect(warned[0]).toContain(`${d}/brief.d/10.md`);
			expect(warned[0]).toContain("EACCES");
		});
		test("an unreadable fragment (0200) is skipped with a warning naming it and why; the others are used", () => {
			const d = conf();
			put(d, "10-locked.md", "locked\n");
			put(d, "20-ok.md", "ok\n");
			chmodSync(`${d}/brief.d/10-locked.md`, 0o200);
			const warned: string[] = [];
			expect(loadBriefFragments(d, (m) => warned.push(m))).toEqual(["ok"]);
			expect(warned).toHaveLength(1);
			expect(warned[0]).toContain(`${d}/brief.d/10-locked.md`);
			expect(warned[0]).toContain("EACCES");
		});
		test("a brief.d at 0755 with a 0644 fragment (umask 022) is accepted with no warning", () => {
			const d = conf();
			put(d, "10.md", "ok\n");
			expect(statSync(`${d}/brief.d`).mode & 0o777).toBe(0o755);
			expect(loadBriefFragments(d, () => { throw Error("no warning expected"); })).toEqual(["ok"]);
		});
	});

	test("fragments follow the generic brief, one blank line apart, and the brief is unchanged without them", () => {
		const plain = stewardBrief(base);
		expect(stewardBrief({ ...base, fragments: [] })).toBe(plain);
		const b = stewardBrief({ ...base, fragments: ["## Landing\n\n- Merge on green.", "# Repo\n\ntext"] });
		expect(b).toBe(`${plain}\n\n## Landing\n\n- Merge on green.\n\n# Repo\n\ntext`);
	});

	test("fragments go before an Open work at hand-over section", () => {
		const brief = `# You are the Steward\n\nbody\n\n${OPEN_WORK_HEADING}\n\n- thread x waits on Ada\n`;
		expect(withFragments(brief, ["## Landing", "## Repo"])).toBe(`# You are the Steward\n\nbody\n\n## Landing\n\n## Repo\n\n${OPEN_WORK_HEADING}\n\n- thread x waits on Ada\n`);
		expect(withFragments("# A\n\nbody\n", ["## F"])).toBe("# A\n\nbody\n\n## F");
	});
});
