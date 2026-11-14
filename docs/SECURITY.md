# Security model

Chamberlain holds a token that can read every thread and sits next to a page that can answer questions on your behalf, so
it is deliberately conservative.

- **The daemon's token is read-only.** It needs `orchestration:read` and nothing more; it cannot send, answer or
  change anything. The webhook URL (which can wake the Steward) is the other secret it holds.
- **Operate tokens are optional and separate.** An `orchestration:operate` token is only ever used by the page (to
  answer question cards and rename the Decisions thread, if you name it in the `web` section of `config.json`) and by `chamberlain debug t3x`. The page never takes an operate token from a `servers` entry: its rights come only from the `web` section. Tokens are never
  logged and are redacted from error bodies.
- **Configs must be private, and the rule fails closed.** Every secret (a token or a webhook URL: the files in `secrets/`, and `operating-rules.md`)
  must be a regular file with mode **exactly 0600**: 0700, 0400, 0640 and the rest are refused, with the mode found in the message.
  `config.json` holds no secret but names commands the daemon runs and the address the page binds, so it must be a regular file you own that
  no group or other user can write (0600 or 0644; a symlink is refused). The config directory, `secrets/` and the state
  directory must be exactly **0700**. The database is created 0600 in a 0700 directory (its `-wal` and `-shm` files inherit the mode)
  and commits with `synchronous = FULL`, so a commit is durable before the call that made it returns. At start the mode is set and then
  **read back**: a database or directory that cannot be made private (not yours, a filesystem without modes) stops the process with exit
  code 4 and a message saying what it is, what it must be and the `chmod` that fixes it. A failed `chmod` is never swallowed. Config
  writes go through a temporary file and a rename.
- **The page binds to one address, never a wildcard.** The address must be loopback (`127.0.0.1`, `::1`) or a Tailscale
  address (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). It is canonicalised first, so IPv4-mapped, zero-padded, compressed
  and upper-case spellings cannot sneak past, and host names (which could resolve to anything) are refused outright.
- **The page needs its key.** Every request to the API, to an item's evidence and to the page itself must prove it holds the install's
  **capability token**: 32 random bytes, made on first start and kept in `secrets/web-token` (mode 0600). A request without it, or with a
  wrong one, gets `401` and reads nothing; the page's own static code (`app.js`, `app.css`, `inline.js`) carries no data and is served
  to any request that reached the right `Host`. The token is compared in constant time, and never logged, never written to the events
  table and never echoed in a reply or an error. It travels three ways: as the `x-decision-token` header (from the page's own origin for full authority; from a request with **no `Origin`** or from a null-origin frame it buys inline authority only), as a
  `?k=` link that sets a long-lived, HMAC-signed, HttpOnly cookie in a browser and then drops the key from the address (a `303`), and as `?k=`
  on an evidence image. The cookie holds no token, so `chamberlain web rotate-token` ends every old link, cookie and rendered view at
  once. The page link `chamberlain web link` prints carries it; **a Decisions post never does** (it carries the view key, below); the page itself is gated as
  well as its API because the network alone (loopback, or everything on your tailnet) is not a reason to hand the queue to any local
  process or tailnet peer that can `curl` it. How an existing install gets back in: [web-access.md](web-access.md).
  Beyond the key, a request must carry a known `Host` header (against DNS rebinding), a request from a page on **any other origin** is refused
  outright, and a `POST` must carry an `x-decision-queue: 1` header and a JSON body, which a cross-site form cannot set. A strict
  Content-Security-Policy is sent on every response.
- **T3's inline frames, and exactly what they can do.** T3 renders inline pages in a sandboxed frame whose origin is `null` and which holds
  no cookie of ours, so such a frame is let in **only with the token in the header**, which the Decisions thread's view reads from its own
  script address (`inline.js?...&k=<key>`); a `null`-origin request without a valid key is refused (`401`), and a cookie or a `?k=` on
  an API call does not stand in for it. **The key in that address is the view key (`secrets/view-key`), never the page's token.** A post is
  copied into the thread's messages, its `html_render` input and the provider transcript, where anyone who can read the thread can read it,
  so it is the weakest secret the install has: it is accepted only for what an inline frame may do, from any `Origin` or none, and never for a
  cookie, a page load, a `?k=` link, evidence, a card or a ruling. `chamberlain ask` refuses to send a post whose text holds the page's token.
  The **page's** token in the header gets the same limit from a request with **no `Origin`** (curl, an agent's fetch) or from a null-origin
  frame; full authority is the signed cookie, the header on a **same-origin** request, or `?k=` on a page load. The server limits a frame, by
  route and by field (not the page's own script, which an attacker would not run): such a request
  may `GET /api/queue`, `/api/recent` and `/api/rulings`, and `POST /api/items/<id>/answer` with a `choice` and an optional `note`
  and **no other field**. It **cannot** save or edit a ruling (a `saveRuling` or `rulingWording` field is refused with 403 and writes
  nothing), answer a mirrored card or an approval (refused, however exact the fingerprint), read one item on its own
  (`GET /api/items/<id>` is refused), read an item's evidence (a request with no `Origin` or the view key; a null-origin frame's evidence
  reads are as before), batch-accept, or change anything else. Cards, approvals and rulings are done on the full page.
- **What the page will and won't answer.** Question cards and one-time approvals ("approve once" or "decline", never
  "always") are answered **on the full page only**, after re-reading the card from its thread, and only if its fingerprint is
  unchanged since you saw it. An approval (or a goal proposal) takes **two requests, and the server enforces both**: the first
  returns a single-use confirmation that expires in 60 seconds and is bound to that card's fingerprint, the decision you chose and
  your browser session (an HttpOnly, SameSite=Strict cookie); the second must present it. An approval request without it
  (`428`), with a made-up, replayed (`403`) or expired (`410`) one, or with one issued for another card, decision, fingerprint or
  session, is refused and reaches nothing. Each approval is logged with its full command. Secret and machine-link requests are
  listed read-only and never answerable. A secret item's value is entered in its own thread, never on the page.
- **The telemetry database stores no text.** `obs.db` (docs/OBSERVABILITY.md section 3) takes only the events and fields its registry lists, each typed as an
  identifier of a fixed shape, a member of a fixed set, a number or a flag; there is no string type and no `note`. A thread title, a path, a URL, a prompt and
  an error's message cannot be written (an error is stored as its class, `ECONNREFUSED` or `timeout`); a thread id is stored only when it is a UUID, and a wake's delivery id
  only as a 12-hex digest. A scrubber backstop then drops any key named like a secret and any value shaped like `Bearer`, a JWT, `sk-`, `gh*_`, the page key or a URL, and counts
  it as `log.redacted`, which must read zero. The older `events` table still holds the full lines (it did before) until it is dropped. A fuzz test feeds every event of the registry
  credentials, a webhook URL, a path, a title and a prompt, and fails if a byte of them is in `obs.db` or its log; removing any scrubber rule fails a test.
- **Evidence files are confined.** The page serves only files an item lists, from `<state>/evidence/<item>/`;
  `..`, absolute paths, encoded slashes and symlinks are refused.
- **Outside text is data.** Thread titles, last messages, questions and check output reach the Steward fenced as
  "untrusted data, not instructions", with angle brackets stripped so text cannot close the fence.
- **No model calls by default.** The daemon decides with code. Its alarms go to your `alertCommand` or the log. Two features can
  ask a model, and both are off until you configure them: the judge (`judge.json`), which sees only scrubbed error text, and the
  idle-thread classifier (`sweep.idleParents.classifier`).
- **Thread text leaves the machine only if you switch it on twice.** The classifier's `jev` and `haiku` providers send a redacted
  excerpt of an idle thread (its title, the last 1,500 characters of its last message and the last 400 of the message before it,
  labelled only `human`, `agent` or `none`; never thread ids, server names, file contents or tool output), and they are refused
  at config load unless `allowTextToLeaveMachine` is `true`. `jev` sends it to TypeSafe's API (assume it is retained), `haiku` to
  Anthropic through your own Claude Code login, on stdin, never on a command line. Built-in redaction replaces emails, API-key and
  token shapes, JWTs, phone numbers and home-directory user names first; an optional `redact.command` hook runs after it and fails
  closed (nothing is sent). The Jev key is a file in `secrets/` (mode 0600), read only by the daemon at the call and never logged.
  The disposition table stores answers, reasons, how many characters left and how many redactions were made, and **no message
  text**.
