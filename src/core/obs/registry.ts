/**
 * The event registry (docs/OBSERVABILITY.md section 3): every event `obs.db` stores, with the fields it may carry and each field's opaque type.
 * An event or field that is not here is dropped and counted (`log.rejected`), never stored and never thrown.
 *
 * Two kinds of caller meet it:
 *   - typed code calls `log.info("wake.delivered", { http: 202 })`: the field names are the registry's, and an extra one is rejected;
 *   - the existing call sites call `log("delivered", { deliveryId, error: String(e), title })`: the registry's `legacy` name finds the event, and
 *     each field names the old key it is read from (`from`) and how (`via`). Whatever the registry does not name is left behind, which is
 *     exactly how a title, a path or an error message never reach `obs.db`. (The old `events` table keeps the old line until release C.)
 *
 * Four keys are not fields but columns, lifted by obs.ts: the thread (`threadId`), the delivery (`deliveryId`, kept as its digest), the
 * correlation id and the question item. Every field name must stay clear of the scrubber's key rule (no `token`, `secret`...): a test checks.
 */
import { ERR_TYPE, type FieldType, T } from "./fields.ts";

/** How an old value becomes a field's: `len` is an array's length, `err` is `errClass`, `corrs` is each delivery id as its digest. */
type Via = "len" | "err" | "corrs";
export type FieldSpec = { type: FieldType; from?: string; via?: Via };
export type Level = "debug" | "info" | "warn" | "error";
/**
 * A transition event: the first sighting of `state` for `key` (`<family>.<name>`) is stored, repeats are counted into `suppressed`, and a
 * change of state is stored with the count of what it suppressed. `change` says which legacy event enters a state, `recovers` which leaves it.
 */
type ChangeSpec = { family: string; state: string; name: string };
export type EventSpec = {
	level: Level;
	legacy?: string;
	fields: Record<string, FieldSpec>;
	enters?: ChangeSpec;
	leaves?: ChangeSpec;
};

const f = (type: FieldType, from?: string, via?: Via): FieldSpec => ({
	type,
	...(from ? { from } : {}),
	...(via ? { via } : {}),
});
const int = (from?: string) => f(T.int, from);
const ms = (from?: string) => f(T.ms, from);
const bool = (from?: string) => f(T.bool, from);
const len = (from: string) => f(T.int, from, "len");
const corrs = (from: string) => f(T.list(T.hex12, 200), from, "corrs");
const SRV = f(T.known("server"), "server");
const RCV = f(T.known("receiver"), "receiver");
const ERR = f(ERR_TYPE, "error", "err");
const ITEM = f(T.item, "item");
const ITEM_FROM_ID = f(T.item, "id");
const HTTP = int("http");
const ATTEMPT = int("attempt");
const KIND = f(
	T.enm(
		"needs_input",
		"failed",
		"turn_ended",
		"compact",
		"sweep",
		"digest",
		"alert",
		"question",
		"pending",
		"idle",
		"report",
		"rights",
		"preamble",
		"stale",
		"card",
		"window",
		"thread",
		"only-you",
		"product",
		"ruling",
		"idea",
	),
	"kind",
);
const FAILURE = f(
	T.enm(
		"stream_closed",
		"rate_limit",
		"capacity",
		"provider_turn_failed",
		"oom",
		"auth",
		"cloudflare",
		"safety",
		"quota",
		"workspace",
		"interrupted",
		"unknown",
	),
	"kind",
);
const ORIGIN = f(T.enm("page", "batch", "card", "daemon", "reconciler"), "by");
const WAKE_ACTION = f(T.enm("none", "findings", "full"), "wake");

const e = (
	level: Level,
	fields: Record<string, FieldSpec> = {},
	legacy?: string,
	change?: Pick<EventSpec, "enters" | "leaves">,
): EventSpec => ({
	level,
	...(legacy ? { legacy } : {}),
	fields,
	...change,
});

/** Failures of the daemon's own housekeeping: one shape, one class. */
const failure = (legacy?: string) => e("warn", { err: ERR }, legacy);
/** A server problem: which server and what class of error. */
const serverFailure = (level: Level = "warn") => e(level, { server: SRV, err: ERR });

export const EVENTS = {
	// ---- the wake path -----------------------------------------------------------------------------
	"wake.queued": e("info", { kind: KIND }, "deliver-queued"),
	"wake.held": e("info", { kind: KIND }, "deliver-held"),
	"wake.composed": e(
		"info",
		{ members: corrs("members"), kept: corrs("kept"), folded: int(), forced: f(T.enm("ceiling")) },
		"composed",
	),
	"wake.delivered": e(
		"info",
		{ http: HTTP, attempt: ATTEMPT, kind: KIND, receiver: RCV, members: len("members") },
		"delivered",
	),
	"wake.error": e("warn", { attempt: ATTEMPT, err: ERR }, "deliver-error"),
	"wake.dead-letter": e("error", { attempts: int(), receiver: RCV }, "deliver-dead-letter"),
	"wake.dead-letter-reported": e("error", { attempts: int() }, "deliver-dead-letter-reported"),
	"wake.stale": e("warn", { age_ms: ms("ageMs") }, "deliver-stale"),
	"wake.not-ready": e("info", { receiver: RCV }, "deliver-not-ready"),
	"wake.no-receiver": e("warn", { receiver: RCV }, "deliver-no-receiver"),
	"wake.receiver-unconfigured": e("warn", { receiver: RCV, rows: int(), held: int() }, "deliver-receiver-unconfigured"),
	"wake.already-queued": e("info", {}, "deliver-already-queued"),
	"wake.cancelled-after-send": e("warn", {}, "delivered-after-cancel"),
	"wake.record-failed": failure("delivered-record-failed"),
	"wake.hook-error": failure("on-delivered-error"),
	"wake.dry": e("info", {}, "dry"),
	"wake.synthetic": e("info", {}, "synthetic-wake-queued"),
	"relay-lock-released": e("info"),
	"relay-error": failure(),
	"gate-error": e("warn", { err: ERR, receiver: RCV }),
	"rights-first": e("info"),
	"rights-first-error": failure(),
	"rights-first-skipped": e("info"),
	"rights-first-waiting": e("info"),
	"rights-first-obsolete": e("info"),
	"rights-full-stale": e("warn", { epoch: int(), current: int() }),
	"rights-invalidated": e("info", { reason: f(T.enm("compaction", "context shrink")), epoch: int(), used: int() }),
	"rights-sent-unsaved": failure(),
	// ---- what the engine saw and decided ---------------------------------------------------------------
	fire: e("info", { server: SRV, kind: KIND, idle: bool(), used: int() }),
	"fire-error": serverFailure("error"),
	"skip-children-running": e("info", { server: SRV }),
	"skip-turn-ended": e("info", { server: SRV }),
	"skip-read-failed": e("warn", { server: SRV }),
	"skip-read-truncated": e("warn", { server: SRV }),
	"skip-empty": e("info", { server: SRV }),
	"skip-empty-wait": e("info", { server: SRV }),
	"skip-request-seen": e("info", { server: SRV }),
	"skip-decisions-thread": e("info", { kind: KIND }),
	"skip-report-superseded": e("info", { server: SRV }),
	"skip-compact": e("info"),
	"compact-clear": e("info"),
	"held-by-daemon": e("info", {
		server: SRV,
		kind: f(T.enm("user_input_request", "approval_request", "secret_request", "link_request")),
	}),
	"read-failed": serverFailure(),
	"instruction-read": e("warn", { server: SRV }),
	"idle-check-failed": serverFailure(),
	"card-item-ignored": e("warn", { server: SRV }),
	"card-question-post-failed": e("warn", { server: SRV, err: ERR }),
	"card-read-unavailable": e("warn", { server: SRV }),
	"card-read-recovered": e("info", { server: SRV }),
	"card-unverified": e("warn", { server: SRV }),
	"card-reconciled": e("info", { server: SRV }),
	"held-closed": e("info", { server: SRV, closed: int() }),
	"held-close-error": serverFailure(),
	"held-closed-for-item": e("info", { item: ITEM, closed: int() }),
	"held-close-failed": e("warn", { item: ITEM, err: ERR }),
	"held-reconciled": e("info", { closed: int(), errors: int(), ran: bool() }),
	"held-reconcile-error": e("warn", { pass: f(T.enm("items", "refs", "cards")), err: ERR }),
	"claim-recovered": e("info", { item: ITEM }),
	"claim-recover-error": e("warn", { item: ITEM, err: ERR }),
	"idle-parents": e("info", { reported: int(), err: ERR }),
	"idle-parents-error": failure(),
	sweep: e("info", { wake: WAKE_ACTION, findings: len("findings"), errored: int(), shadow: len("shadow") }),
	"sweep-error": failure(),
	"sweep-afk-unreadable": failure(),
	"rulings-unreadable": failure(),
	// ---- the page --------------------------------------------------------------------------------------
	"web-start": e("info", { port: int(), test: bool() }),
	alarm: e("warn"),
	"alarm-emit-failed": failure(),
	"mirror-servers-error": failure(),
	"mirror-error": serverFailure(),
	"mirror-recovered": e("info", { server: SRV }),
	"mirror-answer-error": e("warn", { server: SRV }),
	"mirror-goal-accepted": e("info", { server: SRV }),
	"mirror-approval-answered": e("info", { server: SRV }),
	"mirror-answered": e("info", { server: SRV }),
	"background-error": failure(),
	"recover-error": failure(),
	"relayed-to-thread": e("info", { item: ITEM }),
	"relay-record-failed": e("warn", { item: ITEM, err: ERR }),
	answered: e("info", { item: ITEM_FROM_ID, choice: int(), by: ORIGIN }),
	"wake-queued": e("info", { item: ITEM_FROM_ID }),
	"card-confirmation-issued": e("info", { item: ITEM_FROM_ID }),
	"card-confirmation-refused": e("warn", { item: ITEM_FROM_ID }),
	"ruling-changed": e("info"),
	"title-set": e("info"),
	"title-skipped": e("info"),
	"title-error": failure(),
	// ---- recovering a failed thread --------------------------------------------------------------------
	"recover-state-unsaved": failure(),
	"recover-breaker-reset": e("info"),
	"recover-stand-down": e("info", { kind: FAILURE }),
	"recover-ping-failed": e("warn", { kind: FAILURE }),
	"recover-retried": e("info", { kind: FAILURE }),
	"recover-read-failed": failure(),
	"recover-breaker": e("error", { kind: FAILURE, count: int(), fresh: bool() }),
	"recover-breaker-alarm": e("error", { kind: FAILURE, count: int() }),
	"recover-ask": e("info", { kind: FAILURE, count: int() }),
	"recover-ask-failed": failure(),
	"recover-judged": e("info"),
	"recover-scheduled": e("info", { kind: FAILURE, in_ms: ms("inMs") }),
	"recover-restored": e("info"),
	"judge-off": e("info"),
	"judge-config-error": e("warn"),
	"judge-failed": e("warn", { err: ERR }),
	// ---- the idle-thread classifier and the Alert Desk ---------------------------------------------------
	"classifier-error": failure(),
	classifier: e("info", {
		provider: f(T.enm("rules", "jev", "haiku", "none")),
		mode: f(T.enm("shadow", "live")),
		calls: int(),
		cached: int(),
		escalate: int(),
		nudge: int(),
		settle: int(),
		ignore: int(),
		unknown: int(),
		dailyBudgetSpent: bool(),
	}),
	"alert-desk-start": e("info", { offset: int(), skippedBytes: int() }),
	"alert-desk": e("info", { events: int(), bad: int(), stale: int(), woke: len("woke"), deferred: int() }),
	"alert-desk-error": failure(),
	// ---- the daemon ------------------------------------------------------------------------------------
	start: e("info", { dry: bool() }),
	adapters: e("info"),
	"startup-recovered": e("info"),
	"state-on-network-filesystem": e("warn"),
	"maintain-error": failure(),
	"tick-error": e("error", { err: ERR }),
	"heartbeat-error": failure(),
	"relay-audit-error": failure(),
	"steward-check-error": failure(),
	"steward-health-error": failure(),
	"steward-usage-error": failure(),
	"watch-error": serverFailure("error"),
	"relay-lock-unavailable": e("error", { err: ERR }),
	"relay-database-linked": e("error", { links: int() }),
	"relay-refused": e("error"),
	"config-migrated": e("info"),
	"config-migrate-failed": e("error"),
	"config-migrate-problem": e("warn"),
	"config-legacy-files": e("warn"),
	"config-legacy-reappeared": e("warn"),
	"schema-migrated": e("info"),
	"schema-migrate-skipped": e("warn"),
	// ---- a backend's connection ---------------------------------------------------------------------------
	connected: e("info", { server: SRV }, undefined, { leaves: { family: "server", state: "up", name: "server" } }),
	disconnected: e("warn", { server: SRV }),
	"session-error": e("warn", { server: SRV, err: ERR }, undefined, {
		enters: { family: "server", state: "down", name: "server" },
	}),
	"compat-ok": e("info", { server: SRV }),
	"compat-warning": e("warn", { server: SRV }),
	// ---- the ledger, derived (source_key set; src/core/obs/ledger.ts) -------------------------------------
	"decision.logged": e("info", { cited: int() }),
	"question.asked": e("info", {
		item: ITEM,
		options: int(),
		recommended: int(),
		urgent: bool(),
		own_thread: bool(),
		card: bool(),
	}),
	"question.answered": e("info", {
		item: ITEM,
		choice: int(),
		recommended: bool(),
		by: ORIGIN,
		wait_ms: ms(),
		ruled: bool(),
	}),
	"hold.closed": e("info", { open_ms: ms(), card: bool() }),
	// ---- the logger's own, and a transition's ---------------------------------------------------------
	"server.state": e("info", {
		name: f(T.known("server")),
		state: f(T.enm("up", "down")),
		suppressed: int(),
		err: { type: ERR_TYPE },
	}),
	"obs.reconciled": e("info", { scanned: int(), emitted: int(), skipped: int() }),
} satisfies Record<string, EventSpec>;
/** The names of the registered events: what a typed call may name. */
export type EventName = keyof typeof EVENTS;

/** Transition families (`log.change("server.mac", "down")`): the event a state change is stored as, its name's set and its states. */
export const FAMILIES: Readonly<Record<string, { event: string; set: string; states: readonly string[] }>> = {
	server: { event: "server.state", set: "server", states: ["up", "down"] },
};

/** The registry name of a legacy event name (the name the existing call sites use), or the name itself. */
const BY_LEGACY = new Map<string, string>(
	Object.entries(EVENTS).flatMap(([name, spec]) => (spec.legacy ? [[spec.legacy, name] as [string, string]] : [])),
);
export const canonical = (event: string): string | undefined =>
	Object.hasOwn(EVENTS, event) ? event : BY_LEGACY.get(event);
