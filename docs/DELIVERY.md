# Delivery: the outbox, the relay and dead letters

A wake is a message to the Steward's thread. Chamberlain's guarantee is **at-least-once, with stable ids**: the webhook that
carries a wake cannot de-duplicate, so every wake keeps one delivery id for good, and the Steward's templates tell it to treat a wake
whose delivery id it has already handled as a repeat and do nothing more.

- Every process that makes a wake (the daemon, the page, the sweep, the tools) writes it as a row in the **outbox**, in the same
  transaction as whatever made it necessary (the transactional outbox pattern). A crash cannot leave a notification recorded without its
  wake, or a wake without its notification.
- Only the daemon's **relay** sends rows, one at a time. No other process calls a wake transport or opens a connection to the webhook,
  and a test fails if one does.
- A row's delivery id and text are frozen when it is written, so every POST of it is the same.
- A row is POSTed at most 3 times (`CHAMBERLAIN_MAX_ATTEMPTS`). Each attempt is committed before its POST, so repeated crashes cannot
  exceed the cap. If the webhook accepts a POST and the daemon dies before recording it, the row is sent again after the restart, under
  the same id.
- A row that used its attempts is kept as a **dead letter** and reported, never sent without end and never dropped for its age; you
  decide what happens to it (below).
- While the Steward is busy, turn ends, sweeps, decision-queue answers and threads' notes wait in a held store and go out as one
  **digest** when it is idle again (or after a 20-minute ceiling; three minutes for an answer), each member keeping its own id. Answers
  and notes are never folded. A question, an approval or a failure is never held: the thread behind it is blocked until the Steward acts. A holdable `turn_ended` is queued slim (one-line outcome, server, threadId, rights
  pointer — no full rights block and no Last-message fence); Steward peeks the thread for detail. A rights gap still gets one
  rights-first prerequisite at send time, not a full block copied into every held item.

The windows that remain, exactly, are in [ARCHITECTURE.md](ARCHITECTURE.md#delivery-guarantees-and-the-windows-that-remain). The crash
tests start the real daemon and page as child processes and kill them at each step.

## Reports from other threads: `chamberlain note`

A thread that reports to the Steward with a message straight into the Steward's thread (`t3_thread_send`) queues a turn of its own,
however busy the Steward is. `chamberlain note` sends the same report through the outbox instead:

```sh
chamberlain note --from "<your thread's title>" --thread <your thread id> [--server <name>] '<the report>'
chamberlain note --from "<your thread's title>" --thread <your thread id> - < report.txt
```

The note is held (kind `note`): an idle Steward gets it at once, a busy one gets it in its next digest, each note its own item and never
folded into another. Its delivery id is made from the sender and the text, so the same note sent twice is one wake. Run it on the Steward's
machine, where the daemon reads the database; from another machine, over ssh. It refuses (exit 3) when no daemon has beaten in that
state directory in the last five minutes, because a note written where no daemon reads would never go: send it with `t3_thread_send` then.
A note is at most 8000 characters and must fit the relay's 24,000-byte bound once UTF-8 encoded, with room for a Steward switch's transfer
header; put longer detail in a file and send its path. `--from` is one line of at most 120 characters, and `--thread` and `--server` are
single tokens: they sit outside the report's fence, so anything else is refused.

## Dead letters

Only the daemon sends wakes (no other process calls a wake transport or opens a connection to the webhook, and a test fails if one does): the page, the sweep and `chamberlain debug synthetic-wake` write rows, and the daemon's relay POSTs them on its next poll (one second by default) when it is not busy sending an earlier row (sends are one at a time, so a stuck send, up to the 15 second deadline, delays the rows behind it). If
the daemon is not running, rows wait (the page still says "recorded, wake queued") and go when it starts. Each row gets 3 attempts
(`CHAMBERLAIN_MAX_ATTEMPTS`), a minute and then four minutes apart, and **every outcome counts**: an HTTP error, a refused connection
and a timeout each use one. A row that is not delivered after its attempts is a **dead letter**: kept (nothing is dropped), not sent
again, and the `wake-dead-letter` alarm repeats. The Steward may or may not have received it. A webhook that is down for more than about
five minutes therefore dead-letters the wakes written meanwhile; with no wake URL at all, nothing is attempted and nothing is used up.

1. See what is waiting: `chamberlain wakes list`. It names each dead letter and pending row, its attempts, when it was made and last
   tried, and a digest's members.
2. Find out why it was not delivered (the webhook revoked, the T3 server down, a full disk) and fix that first. The daemon's log shows
   `deliver-error` and `deliver-dead-letter` events.
3. Look in the Steward's thread for the delivery id. If it never arrived, `chamberlain wakes retry <id>` puts the row back to pending with
   its attempts at zero; the relay sends it, the same id, text and members, on its next poll (see above for when that can be later). If the Steward already handled it,
   `chamberlain wakes cancel <id>` gives it up.

`retry` works only on a dead letter, so it can never add a send beside one in progress. `cancel` works on a pending row or a dead letter
and keeps it as a **tombstone**: the row and the ids it carries stay, so nothing queues them again, and it is not recorded as delivered. A
decision-queue answer whose wake you cancel stays recorded as answered; tell the Steward in chat. `retry` takes any id a row carries, a
digest member's included. `cancel` takes a digest only by its own id: a digest is one row, so cancelling it gives up every answer, note and
turn end in it, and a member's id alone is refused with the digest's id and members named. A held wake (`list` names each one) has no row
yet, so there is nothing to cancel until it is composed.
