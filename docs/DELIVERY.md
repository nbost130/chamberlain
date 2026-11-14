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
- While the Steward is busy, wakes wait in a held store and go out as one **digest** when it is idle again (or after a 20-minute
  ceiling), each member keeping its own id.

The windows that remain, exactly, are in [ARCHITECTURE.md](ARCHITECTURE.md#delivery-guarantees-and-the-windows-that-remain). The crash
tests start the real daemon and page as child processes and kill them at each step.

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
decision-queue answer whose wake you cancel stays recorded as answered; tell the Steward in chat. Any id a row carries works, a digest
member's included.
