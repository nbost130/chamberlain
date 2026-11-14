Referred to from [docs/ADAPTERS.md](../docs/ADAPTERS.md). It is here, not there, because it is a design for an adapter nobody has built.

# Sketch: a herdr adapter

**This is a sketch, not an implementation.** herdr is a terminal workspace manager. Its socket API has `events.subscribe`
(a stream of events such as `pane.agent_status_changed`), `agent.get`, `agent.send` and `notification.show`, and an agent
status of `idle`, `working`, `blocked`, `done` or `unknown` (run `herdr api schema --json` for the exact shapes; the notes
below are checked against protocol 16). Requests are `{ id, method, params }` and answered by `{ id, result }`; `agent.list` answers with `{ type: "agent_list", agents }`, each agent carrying `pane_id`, `title`, `agent_status` and `cwd`.

The mapping, from the contract to herdr:

| Contract | herdr |
| --- | --- |
| a thread | an agent pane; `id` is the `pane_id`, `title` is the pane's `title` (or its agent name) |
| `status` | `working` → `running`, `blocked` → `waiting`, `done` → `completed`, `idle` → `idle`; `unknown` → report nothing (keep the last known status) |
| `watch` | connect to the socket, `events.subscribe` with `[{ type: "pane.agent_status_changed" }]`, and report each event as a `state`; on connect, `agent.list` for the first sighting of every pane |
| `needs_input` | falls out of the rules: a pane that goes to `blocked` is a thread that went to `waiting`. There is no request id, so none is given |
| `turn_ended` | `working` → `done` or `idle` is a live thread that ended |
| `failed` | herdr has no failed status, so this never fires; a pane that exits is the nearest thing and is out of scope for the sketch |
| `wake` | `agent.send { target: <the Steward's pane>, text: message }`. `ready()` is true when the Steward's pane id is known |
| `isBusy()` | the last `agent_status` seen for the Steward's pane (kept from the event stream, refreshed with `agent.get`): `working` or `blocked` → `busy`, `idle` or `done` → `idle`, `unknown` → `unknown` |
| `post` | `notification.show { title, body }`: a toast, so `where` is `"notice"`; the page is the live view |
| `listWaiting` | optional: `agent.list`, the `blocked` panes, as read-only `question` cards whose `why` is "answer it in its pane" |
| `answer`, `setTitle`, `send`, `compact`, `alertDesk` | omitted: herdr answers happen in the terminal, and there is no Decisions thread |
| `inspect` | omitted at first. `agent.read` could supply `lastMessage` from the screen, but herdr keeps no instruction history, so without `inspect` every top-level turn end is its own report |
| `transcriptPath` | optional: when the Steward is a Claude Code pane, `agent.get` returns its `agent_session` (a path or an id) |
| the Steward | `threads.steward` holds its pane id, as it holds a thread id for T3 |

The shape of it:

```ts
// src/adapters/herdr/index.ts  (a sketch: not built, not registered)
import type { Adapter, AdapterFactory, ThreadInput, WatchSink } from "../../core/adapter.ts";

const STATUS: Record<string, string | undefined> = { working: "running", blocked: "waiting", done: "completed", idle: "idle", unknown: undefined };

export const createHerdrAdapter: AdapterFactory = (env) => {
  const socket = String(env.server.socket ?? "");              // your `servers` key
  if (!socket) throw Error(`servers.json: ${env.server.name}: a herdr server needs socket`);
  let busy: "idle" | "busy" | "unknown" = "unknown";            // the Steward's last status, kept from events
  const call = (method: string, params: object) => rpc(socket, { id: crypto.randomUUID(), method, params });   // newline-framed JSON; see the schema

  const adapter: Adapter = {
    id: "herdr",
    capabilities: ["transcriptPath"],                           // plus whatever else you build
    async watch(sink: WatchSink, signal: AbortSignal) {
      while (!signal.aborted) {
        try {
          // first sighting of every pane, then the stream
          for (const a of (await call("agent.list", {})).agents) sink.event({ kind: "state", thread: toThread(a) });
          sink.connected(true);
          for await (const ev of subscribe(socket, [{ type: "pane.agent_status_changed" }], signal)) {
            const status = STATUS[ev.agent_status ?? "unknown"];
            if (ev.pane_id === env.steward()) busy = ev.agent_status === "idle" || ev.agent_status === "done" ? "idle" : status ? "busy" : "unknown";
            if (status) sink.event({ kind: "state", thread: { id: ev.pane_id, title: ev.title ?? ev.pane_id, status } satisfies ThreadInput });
          }
        } catch (e) { sink.log("session-error", { error: String(e).slice(0, 200) }); }
        sink.connected(false);
        await Bun.sleep(1000);                                  // back off, as the T3 adapter does
      }
    },
    wake: {
      ready: () => Boolean(env.steward()),
      send: async (_deliveryId, message) => {
        await call("agent.send", { target: env.steward(), text: message });   // the text ends with the delivery id; a delivered outbox row is never sent again
        return { ok: true };
      },
    },
    isBusy: () => busy,
    post: async (item) => {
      await call("notification.show", { title: "Decision needed", body: item.title });
      return { ok: true, detail: "shown as a notification", where: "notice" };
    },
    transcriptPath: async () => { /* agent.get on the Steward's pane → agent_session → a path */ throw Error("sketch"); },
  };
  return adapter;
};
```

Things the sketch leaves to whoever builds it: the socket's framing and path (take it from herdr's config and
`herdr api schema`), reconnecting, what a restarted herdr does to pane ids, whether `agent.send` queues while the target
is `working` (the core holds wakes while `isBusy()` says busy, so it should not matter), and a conformance test with the
socket faked.
