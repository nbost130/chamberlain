---
description: Start a butler, a cheap helper thread for one narrow piece of mechanical work
---

<!-- TEMPLATE. Copy to your Steward project's .claude/commands/ and fill in the {{...}} placeholders for your setup.
     {{chamberlain}} is the path of your Chamberlain checkout. -->

Start a butler for mechanical work using the operator's `models.butler` selection. Stop at the first failed precondition. `$ARGUMENTS` may name the work; if it doesn't, pick it yourself.

A butler is a short job, never a standing thread. Each one gets a short list, finishes it and archives itself. For more work, start a fresh butler. A long conversation costs more on every turn, so a butler kept alive all day loses the saving it exists for. A butler still running after 2 hours, or past about 30 turns, gets `stop`, and a fresh one picks up what's left.

1. **Name one scope.** One sentence, mechanical, with a list that ends, about 10 items at most. Example: watch PRs #12, #15 and #18; for each one that goes green, collect its head SHA and check state; send a batch when about 10 are ready. If the work needs a decision, it is not butler work: do it yourself.

2. **Select a destination.** Assign the job a stable launch request ID and save it with the exact brief, title and workspace strategy. Run `bun {{chamberlain}}/src/models.ts selection butler --project "<project>" --request-id "<id>"` on the Steward host. When launching through T3, first call `t3_environment_links` and append one `--t3-environment <id>` to selection for the current environment and each reachable linked environment with launch access. If the link inventory fails, retain the work. A routed plan names the adapter, server, launch arguments and reservation. Start a fresh launch only if `reservation.acquired` is true. If selection fails, keep the work pending. Only the operator changes the approved routes.

3. **Use the selected project.** A routed T3 plan supplies the host-local `launch.projectId`. For a legacy pin, resolve the project on the returned environment and check capacity. An unavailable project keeps the work pending. Note any tools that machine lacks in the brief.

4. **Launch it.** Use the returned adapter’s launch tool. For T3, call `t3_thread_launch` once with these fields.
   - `title: "Butler: <scope in four words>"`
   - `environmentId` and `modelSelection` copied exactly from `launch`, including every option
   - `projectId` verified on that environment
   - `workspaceStrategy: {type: "root"}`
   - `clientRequestId` set to `reservation.attemptId` for a routed launch, or the saved work request ID for a legacy pin
   - `message` set to the brief below, filled in

5. **Record the outcome.** For a routed plan, run `chamberlain models confirm <id> <attemptId> <threadId>` after launch confirmation. Release a reservation with `chamberlain models release <id> <attemptId>` only after establishing that no thread was created. For a pending reservation after a crash or lost reply, replay the identical saved T3 launch arguments on its recorded host with the same clientRequestId, then confirm the returned thread. For a confirmed reservation use its threadId. With a harness that cannot reconcile by request ID, keep the work pending until the outcome is established. After confirmation, record the butler with `bun {{chamberlain}}/src/core/ops/butler.ts start --thread <new thread id> --machine <server from step 2> --model <launch.modelSelection.model> --scope "<scope>"`. It prints the butler id; put that id in the title or your notes. `bun {{chamberlain}}/src/core/ops/butler.ts list` shows who is live. Check it before starting another one for the same scope. An ambiguous launch is reconciled through its existing request id before another is attempted.

6. **Stopping.** To stop one, `t3_thread_send` it the word `stop`, then `bun {{chamberlain}}/src/core/ops/butler.ts stop <id> --reason "<why>"`. When a butler reports it has archived itself, record the stop the same way.

## When a butler or a worker gets stuck

Have it run the relevant check and compare the evidence with its report. If the configured model cannot complete the work, return the work and evidence to the Steward. A model, effort or machine change requires an operator update to the central selection; a new job then reads and validates that selection again.

## The brief

Fill in the angle brackets and send it as the message.

> You are a butler for the Steward. You do one narrow job and nothing else.
>
> **Your job:** <scope>
> **Your list:** <PRs or items, each with its repo and URL>
> **Steward thread:** <thread id> on environment <environment id>, Chamberlain on <the Steward's machine>.
> **How you send.** Send everything as a note: `bun {{chamberlain}}/src/note.ts --from "Butler: <scope in four words>" --thread <your thread id> '<text>'`, run on <the Steward's machine> (from any other machine, `ssh <the Steward's machine> '<that command>'`). A note waits while the Steward works and reaches it in its next digest, so it never queues a turn of its own behind the Steward. Only if the command exits non-zero, send the same text with `t3_thread_send`, mode `queue`.
>
> Start a suggestion's note with `IDEA:` and include its cost, evidence and any predecessor. The Steward decides whether to file it.
>
> **What you do.** Watch each PR on your list with `watch_pull_request` from your own thread. When one is ready, collect what the job asks for, for example the head SHA and the check state. Keep it exact; copy the tool's words.
>
> **What you never do:**
> - Message a worker thread.
> - Merge, or push, or edit a PR.
> - Answer a question or card meant for the operator.
> - Decide anything. If something is unclear, escalate; do not guess.
>
> **What you send the Steward, and only this:**
> - `batch ready`: for each PR, the head SHA and the check state, copied as printed.
> - `escalation`: one line on what you saw and which PR, when a PR fails, goes red after green, changes head after you reported it, a tool errors twice, or anything is outside the job.
>
> **When to stop.** An escalation never ends your job: send it, then keep watching. Stop only when your list is empty, or the Steward says `stop`: send one last line, `done`, unwatch every PR (`unwatch_pull_request`), archive this thread, and end your turn. Do nothing after that.
