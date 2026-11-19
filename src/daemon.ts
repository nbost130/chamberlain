/**
 * Chamberlain's daemon: the engine (src/core/engine/engine.ts) wired to the real world. Every server in servers.json is served
 * by the adapter it names (src/adapters/index.ts); the Steward's own server's adapter wakes the Steward.
 * Config dir: ~/.config/chamberlain/ (CHAMBERLAIN_CONF), state dir: ~/.local/state/chamberlain/ (CHAMBERLAIN_STATE).
 * It is the one relay that sends wakes (core/delivery/relay.ts), so one daemon runs per state directory: a second exits 5 (core/delivery/singleton.ts).
 */

import { adapterNames, loadServers, makeAdapter } from "./adapters/index.ts";
import { findReceipt } from "./adapters/t3/receipts.ts";
import { t3StateDbPath } from "./adapters/t3/settings.ts";
import { postQuestion } from "./ask.ts";
import { CONF, STATE, selfArgv } from "./core/config/config.ts";
import { setting } from "./core/config/layout.ts";
import { startup } from "./core/config/migrate.ts";
import { DEFAULT_WAKE_DEBOUNCE_MS } from "./core/decide/hold.ts";
import {
	holdRelayLock,
	RelayDatabaseLinkedError,
	type RelayLock,
	RelayRunningError,
} from "./core/delivery/singleton.ts";
import { createEngine } from "./core/engine/engine.ts";
import { preparePrConfig } from "./core/engine/engine-prepare-pr.ts";
import { networkFilesystem, RelayLockUnavailableError } from "./core/flock.ts";
import { ghRead } from "./core/gh.ts";
import { type Logger, logFor } from "./core/log.ts";
import { startReconciler } from "./core/obs/ledger.ts";
import { maintain } from "./core/ops/maintain.ts";
import { evidencePass } from "./core/steward/steward-evidence.ts";
import { checkSwitchNotice } from "./core/steward/steward-notice.ts";
import { recoverSteward } from "./core/steward/steward-recover.ts";
import { transferPass } from "./core/steward/steward-transfer.ts";
import { defaultStore } from "./core/store/default-store.ts";
import { SWEEP_PROMPT_FILE } from "./embedded.ts";
import { startModules } from "./modules/index.ts";
import { listRunningRunIdsFromStateDb, parkedSinceFromStateDb } from "./prepare-pr-nm-state.ts";

/** Runs the daemon until it is stopped. It takes no arguments: its settings are the environment and the config directory. */
export async function main(_argv: string[] = process.argv.slice(2)) {
	const store = defaultStore();
	const log = logFor(store);
	const lock = takeRelayLock(store, log);
	const netfs = networkFilesystem(STATE);
	if (netfs) {
		console.error(
			`chamberlain: warning: the state directory is on a network filesystem (${netfs}). SQLite and the one-relay lock are not reliable there; this is unsupported. Use a local directory (CHAMBERLAIN_STATE).`,
		);
		log("state-on-network-filesystem", { fs: netfs });
	}
	// Refuse a file from a newer Chamberlain, and upgrade older ones, before anything reads them.
	startup({ migrate: true, log });
	/** Bound once the engine exists; recovery/notice before that no-ops until raise is wired. */
	let raise: (key: string, title: string, summary: string) => void = () => {};
	// Steward switch recovery (§2.7): seed, clear attempt_gen, adopt, mirror, evidence, transfer — before modules/engine.
	const t3db = t3StateDbPath();
	recoverSteward({
		store,
		conf: CONF,
		log,
		findReceipt: (c) => findReceipt(t3db, { ...c, threads: undefined }),
		alarm: (k, t, s) => raise(k, t, s),
	});
	setInterval(() => {
		try {
			evidencePass(store, (c) => findReceipt(t3db, c));
			transferPass(store);
			checkSwitchNotice(store, raise);
		} catch (e) {
			log("steward-pass-error", { error: String(e).slice(0, 200) });
		}
	}, 30_000);
	// The optional modules whose section of config.json turns them on (none by default: a module that is off starts nothing and makes no file).
	const modules = startModules({ conf: CONF, state: STATE, log });
	process.on("exit", () => modules.stop());
	maintain(store);
	// The ledger's events: one pass soon after start (the backfill, the first time) and one an hour, from a read-only open of chamberlain.db.
	startReconciler(store);
	setInterval(() => {
		try {
			maintain(store);
		} catch (e) {
			log("maintain-error", { error: String(e).slice(0, 200) });
		}
	}, 24 * 3600_000);

	/** Adapters are made before the engine that raises their alarms, so the alarm is bound once the engine exists. */
	const servers = loadServers(CONF).map((server) => ({
		server,
		adapter: makeAdapter(server, { conf: CONF, state: STATE, store, log, alarm: (k, t, s) => raise(k, t, s) }),
	}));

	const engine = createEngine(engineDeps(store, log, lock, servers));
	raise = engine.alarm;
	log("adapters", { registered: adapterNames(), serving: servers.map((x) => `${x.server.name}:${x.server.adapter}`) });
	await engine.start();
}

/** The relay's flock on the state directory, held for this process's life: the operating system lets one process hold it, and frees it when this one dies. A refusal is logged and exits. */
function takeRelayLock(store: ReturnType<typeof defaultStore>, log: Logger): RelayLock {
	try {
		return holdRelayLock(store.path);
	} catch (e) {
		if (e instanceof RelayLockUnavailableError) {
			console.error(`chamberlain: ${e.message}`);
			log("relay-lock-unavailable", { error: e.message.slice(0, 200) });
			process.exit(1);
		}
		if (e instanceof RelayDatabaseLinkedError) {
			console.error(`chamberlain: ${e.message}`);
			log("relay-database-linked", { db: e.db, links: e.links });
			process.exit(1);
		}
		if (!(e instanceof RelayRunningError)) throw e;
		console.error(`chamberlain: ${e.message}`);
		log("relay-refused", { lock: e.lock });
		process.exit(5);
	}
}

/** What the engine is made of: the real config, the lock, the store and the servers, and the daemon's own settings and hooks. */
function engineDeps(
	store: ReturnType<typeof defaultStore>,
	log: Logger,
	lock: RelayLock,
	servers: Parameters<typeof createEngine>[0]["servers"],
): Parameters<typeof createEngine>[0] {
	return {
		conf: CONF,
		lock,
		store,
		servers,
		dry: process.env.CHAMBERLAIN_DRY === "1",
		// Stalled-thread recovery is OFF until `recover` (CHAMBERLAIN_RECOVER=1 or config.json, src/core/ops/recover.ts): merging it changes nothing until it is turned on.
		recover: setting("recover", CONF) === true,
		// The Steward's token usage per wake is OFF until `stewardTokens` (CHAMBERLAIN_STEWARD_TOKENS=1 or config.json, src/core/steward/steward-tokens.ts).
		stewardTokens: setting("stewardTokens", CONF) === true,
		exclude: setting("exclude", CONF) ?? [],
		// Fewer Steward turns, never fewer decisions: the full rights ride inside the next wake instead of a wake of their own (`rightsInline`),
		// and idle turn ends, notes and sweeps wait `wakeDebounceMs` for company so they go as one digest. Each is off with false / 0.
		relay: {
			rightsInline: setting("rightsInline", CONF) !== false,
			...(setting("rightsNoticeRetries", CONF) !== undefined
				? { noticeRetries: setting("rightsNoticeRetries", CONF) as number }
				: {}),
			debounceMs: setting("wakeDebounceMs", CONF) ?? DEFAULT_WAKE_DEBOUNCE_MS,
		},
		log,
		// A snoozed urgent question that returns is shown where the operator reads, in the pinned view like a new one (ask.ts).
		post: postQuestion,
		sweepPromptFile: SWEEP_PROMPT_FILE,
		// The held ledger closes holds whose PR, issue or branch is done (src/core/decide/hold-reconcile.ts).
		gh: ghRead,
		// prepare-pr reads no-mistakes state.sqlite outside core (bun:sqlite boundary); stateDb from sweep.preparePr.
		preparePrNm: {
			listRunning: (workingPath) => listRunningRunIdsFromStateDb(preparePrConfig(CONF).stateDb, workingPath),
			parkedSinceOf: (runIds) => parkedSinceFromStateDb(preparePrConfig(CONF).stateDb, runIds),
		},
		// The Steward-health hand-off question goes through ask.ts like any other, asked only when the adapter cannot start the hand-off itself.
		// A live alarm recurs by nature, so it is never "already settled": the daemon says so, and the question records it.
		ask: async (raw) => {
			const child = Bun.spawn(
				[...selfArgv("ask"), JSON.stringify({ notSettled: "raised by the daemon: a live system alarm", ...raw })],
				{ stdout: "ignore", stderr: "ignore" },
			);
			if ((await child.exited) !== 0) throw Error("steward-health ask failed; queue checked again on retry");
		},
	};
}

if (import.meta.main) await main();
