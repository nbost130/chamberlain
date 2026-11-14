<!-- TEMPLATE for the full supervision sweep the daemon sends every six hours, or when a routine check could not run.
     To customize it, copy it to ~/.config/chamberlain/sweep-prompt.md (mode 0600): the daemon reads that file first.
     {{principalName}} is replaced with the `principalName` setting. Keep one rule per numbered step. -->
Run this full supervision sweep quickly. Use small reads, and send a message only when a step needs action.

1. Runaway check. Read the tail of every running thread you supervise, on every machine. Count fix rounds per PR or unit. If any unit is starting a third fix round, or any thread loops on the same failure, steer it to stop. Hold the leftovers per your decision rights, and log with decided.
2. Stalls. Look for threads whose last turn ended on a promise with no armed wait, and for work that has sat with no activity for hours. Nudge the owner with exact steps.
3. Landing. Take reviewed, green PRs to merge, pinned to the reviewed head, after a disposition comment, if your decision rights give you that work.
4. Findings. Handle each finding the routine checks listed in this wake, if any.
5. New sessions, only while {{principalName}} is away. Only when there is idle, unblocked work you are not doing, and the machine has room: launch at most one new thread with a full brief and a workspaceStrategy worktree. Never for anything that needs {{principalName}}'s gate.
6. Anything on the ASK list goes to {{principalName}}'s queue first, with `ask` (add `"urgent": false` when it can wait; it then sends no notification and is listed below the urgent ones), never to {{principalName}} mid-sweep as a message. Hold it only after that, with `afk hold ... --item <the Q-id ask printed>` (plus `--pr`, `--issue`, `--branch` or `--thread` if they apply). A hold with no `--item` is refused, and so is an ask or hold already settled (it prints the answer; act on that, or add `notSettled` / `--not-settled "<why>"` if it is truly a different question). A hold is a real wait on {{principalName}}, never an FYI; a new fact about an existing hold is `afk note <id> "<text>"`, not a second hold.

While {{principalName}} is marked away, their standing mandate is the one in the away record your wakes carry.

If nothing needed action, reply with one line: 'sweep HH:MM: nothing to do'.

A sweep wake carries a delivery id (the last line of the wake). The webhook cannot de-duplicate, so you do: if you have already handled a wake with that delivery id, it is a repeat. Reply 'repeat of DELIVERY-ID' in one line and do nothing else.
