/** I. TEST mode. */
import { describe, expect, test } from "bun:test";
import { useStewardSwitchFixtures } from "../../testing/steward-switch-fixtures.ts";
import { renderStartPrompt } from "../sweep/sweep.ts";
import { commitSwitch } from "./steward-commit.ts";
import { prepareSwitch } from "./steward-prepare.ts";
import { recoverSteward } from "./steward-recover.ts";

const { confWorld, memStoreSeeded, confFingerprint, writeSwitchRefs } = useStewardSwitchFixtures();

describe("I. TEST mode", () => {
	test("I1: TEST bootstrap leaves steward_gens, switches, secrets hashes and config.json byte-identical", () => {
		const w = confWorld();
		const store = memStoreSeeded(w.conf);
		const fp0 = confFingerprint(w.conf);
		const gens0 = store.steward.maxGen();
		// Simulate TEST daemon recovery (seed already done; adopt/evidence/transfer with no work).
		recoverSteward({
			store,
			conf: w.conf,
			log: () => {},
			findReceipt: () => undefined,
		});
		expect(confFingerprint(w.conf)).toBe(fp0);
		expect(store.steward.maxGen()).toBe(gens0);
		expect(store.steward.openSwitch()).toBeUndefined();
	});

	test("I2: TEST start message has no prepare/switch step; probe titles start with SANDBOX", () => {
		const out = renderStartPrompt("ignored live template with prepare and switch", {
			conf: "/tmp/fake-conf",
			mode: "test",
			compiled: false,
			repo: "/opt/chamberlain",
		});
		expect(out).toContain("TEST Steward");
		expect(out).toContain("SANDBOX");
		// Instructs not to run prepare/switch; must not embed the live prepare/switch steps.
		expect(out).toContain("Do not run prepare or switch");
		expect(out).not.toContain("--live");
		expect(out).not.toContain("secrets/steward");
	});

	test("I3: prepare or switch without --live exits 2", () => {
		const w = confWorld();
		const store = memStoreSeeded(w.conf);
		const p = prepareSwitch(store, w.conf, { toThread: "t2", live: false });
		expect(p).toMatchObject({ ok: false, code: 2 });
		const live = prepareSwitch(store, w.conf, { toThread: "t2", live: true });
		if (!live.ok) throw new Error(live.error);
		writeSwitchRefs(w.conf, live.id);
		const c = commitSwitch(store, w.conf, { id: live.id, live: false });
		expect(c).toMatchObject({ ok: false, code: 2 });
	});
});
