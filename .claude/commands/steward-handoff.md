---
description: Hand the Steward role to a fresh thread with a clean context, then retire this one
---

<!-- TEMPLATE. Copy to your Steward project's .claude/commands/. {{chamberlain}} is the path of your Chamberlain
     checkout and {{state}} its state directory (default ~/.local/state/chamberlain). -->

Hand the Steward role to a fresh thread. The operator runs this, or asks you to. Do it in order and stop at the first step that fails.

1. **Rebuild the brief, then write down the open work.** First rebuild `{{state}}/steward-brief.md` from the builder, so the next Steward gets today's rules and rulings, not an old copy's: `bun {{chamberlain}}/src/brief.ts steward --mode <live|test, as the current brief's "## Mode:" says> > /tmp/brief.new && command mv -f /tmp/brief.new {{state}}/steward-brief.md`. Then add the section `## Open work at hand-over` at the end. For each item, give the thread name, server and full thread id, the PR number and pinned head, what is waiting and on whom, and any answer the operator has given, quoted with its time. Sources:
   - `bun {{chamberlain}}/src/core/ops/afk.ts held`
   - `bun {{chamberlain}}/src/core/ops/decided.ts list 20`
   - `list_thread_pull_requests` for this thread
   - what you know

   Put notes in the brief, not orders. Never copy a webhook URL into it.

2. **Start the new thread with the configured selection.** Run `bun {{chamberlain}}/src/models.ts selection steward`. Its JSON contains `server` and `launch`. A failed command stops the handoff: retain the current thread and its triggers. Use the returned `launch.environmentId` for T3 calls; resolve this project's ID on that exact environment. An unavailable environment or project stops the handoff, with no alternate machine or model. Call `t3_thread_launch` with:
   - `title: "Steward"`
   - `workspaceStrategy: {type: "root"}`
   - `environmentId` and `modelSelection` copied exactly from `launch`, including every option
   - `projectId` verified on that environment
   - one fresh `clientRequestId`, reused if this same launch needs reconciliation
   - `message` set to the exact output of `bun {{chamberlain}}/src/brief.ts start --mode <live|test>`, using the same mode read from the predecessor's brief in step 1; never omit or change that mode

3. **Wait for it:** `t3_thread_wait` on the new thread, up to 5 minutes.

   In TEST mode, stop here: report the test thread's link and retain every existing trigger and watch. Do not run the live switch checks or trigger retirement below. The test startup prompt forbids prepare, switch and live-secret changes.

4. **Check the switch.** `bun {{chamberlain}}/src/cli.ts steward status` must show the committed generation using the new thread, and `bun {{chamberlain}}/src/cli.ts config get threads.steward` must show the same id. If either check fails, stop and retain this thread's tasks; tell the operator exactly what failed.

5. **Retire this thread's triggers.** Run `list_scheduled_tasks`. Delete every task whose `boundThreadId` is this thread and whose title is `Chamberlain: Steward wake` or `Chamberlain: Steward compact`. Also delete one-shot reminders bound to this thread that have already run. A reminder that has not run yet is never deleted: name it in step 6 so the new Steward can recreate it.

6. **Pass on the watches.** Call `unwatch_pull_request` on every PR this thread watches. Then send the new thread one `t3_thread_send` (mode `queue`). It lists:
   - each PR to watch, with its URL and what it waits for
   - any unrun reminder to recreate
   - a pointer to the open-work section of the brief

7. **Reply to the operator** in at most five lines:
   - the new thread's link
   - that the switch worked
   - how many tasks you deleted
   - which PRs and reminders you handed over

   The new thread runs one wake task and one compact task. The old thread may have shown more, which were one-shot reminders.

Never repeat a webhook URL in a reply or in any file but its own.
