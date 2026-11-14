# Security model

Chamberlain holds a token that can read every thread and sits next to a page that can answer questions on your behalf, so
it is deliberately conservative.

- **The daemon's token is read-only.** It needs `orchestration:read` and nothing more; it cannot send, answer or
  change anything. The webhook URL (which can wake the Steward) is the other secret it holds.
- **Operate tokens are optional and separate.** An `orchestration:operate` token is only ever used by the page (to
  answer question cards and rename the Decisions thread, if you name it in `web.json`) and by `chamberlain debug t3x`. The page never takes an operate token from `servers.json`: its rights come only from `web.json`. Tokens are never
  logged and are redacted from error bodies.
- **Configs must be private, and the rule fails closed.** Every file that holds a token, a webhook URL, a command or an address
  (`read-token`, `wake-url`, `settings.json`, `servers.json`, `web.json`, `sweep.json`, `operating-rules.*`) must be a regular file with
  mode **exactly 0600**: 0700, 0400, 0640 and the rest are refused, with the mode found in the message. The config and state
  directories must be exactly **0700**. The database is created 0600 in a 0700 directory (its `-wal` and `-shm` files inherit the mode)
  and commits with `synchronous = FULL`, so a commit is durable before the call that made it returns. At start the mode is set and then
  **read back**: a database or directory that cannot be made private (not yours, a filesystem without modes) stops the process with exit
  code 4 and a message saying what it is, what it must be and the `chmod` that fixes it. A failed `chmod` is never swallowed. Config
  writes go through a temporary file and a rename.
- **The page binds to one address, never a wildcard.** The address must be loopback (`127.0.0.1`, `::1`) or a Tailscale
  address (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). It is canonicalised first, so IPv4-mapped, zero-padded, compressed
  and upper-case spellings cannot sneak past, and host names (which could resolve to anything) are refused outright.
- **The page has no login.** Anyone who can reach its address can read and answer the queue; its protection is the
  network (loopback or your tailnet). A request must also carry a known `Host` header (against DNS rebinding), and a
  `POST` must carry an `x-decision-queue: 1` header and a JSON body, which a cross-site form cannot set.
  A strict Content-Security-Policy is sent on every response.
- **Accepted risk: T3's inline frames, and exactly what they can do.** T3 renders inline pages in a sandboxed frame whose
  origin is `null` and which cannot hold a key, so any page running code in such a frame on a device that can reach the page's
  address can send the same requests, if it knows an item id. The **server** limits them, by route and by field (not the page's
  own script, which an attacker would not run): a `null`-origin request may `GET /api/queue`, `/api/recent` and `/api/rulings`, and
  `POST /api/items/<id>/answer` with a `choice` and an optional `note` and **no other field**. It **cannot** save or edit a
  ruling (a `saveRuling` or `rulingWording` field is refused with 403 and writes nothing), answer a mirrored card or an approval
  (refused, however exact the fingerprint), read one item on its own (`GET /api/items/<id>` is refused), batch-accept, or
  change anything else. Cards, approvals and rulings are done on the full page. What an inline frame *can* still do is answer a
  decision-queue question with one of its options, once: that is the accepted risk.
- **What the page will and won't answer.** Question cards and one-time approvals ("approve once" or "decline", never
  "always") are answered **on the full page only**, after re-reading the card from its thread, and only if its fingerprint is
  unchanged since you saw it. An approval (or a goal proposal) takes **two requests, and the server enforces both**: the first
  returns a single-use confirmation that expires in 60 seconds and is bound to that card's fingerprint, the decision you chose and
  your browser session (an HttpOnly, SameSite=Strict cookie); the second must present it. An approval request without it
  (`428`), with a made-up, replayed (`403`) or expired (`410`) one, or with one issued for another card, decision, fingerprint or
  session, is refused and reaches nothing. Each approval is logged with its full command. Secret and machine-link requests are
  listed read-only and never answerable. A secret item's value is entered in its own thread, never on the page.
- **Evidence files are confined.** The page serves only files an item lists, from `<state>/evidence/<item>/`;
  `..`, absolute paths, encoded slashes and symlinks are refused.
- **Outside text is data.** Thread titles, last messages, questions and check output reach the Steward fenced as
  "untrusted data, not instructions", with angle brackets stripped so text cannot close the fence.
- **No model calls.** The daemon decides with code. Its alarms go to your `alertCommand` or the log.
