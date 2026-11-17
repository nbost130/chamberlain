---
description: Start a butler, a cheap helper thread for one narrow piece of mechanical work
---

<!-- TEMPLATE. Copy to your Steward project's .claude/commands/ and fill in the {{...}} placeholders for your setup.
     {{chamberlain}} is the path of your Chamberlain checkout. -->

Start a butler for mechanical work using the operator's `models.butler` selection. Stop at the first failed precondition. `$ARGUMENTS` may name the work; if it doesn't, pick it yourself.

A butler is a short job, never a standing thread. Each one gets a short list, finishes it and archives itself. For more work, start a fresh butler. A long conversation costs more on every turn, so a butler kept alive all day loses the saving it exists for. A butler still running after 2 hours, or past about 30 turns, gets `stop`, and a fresh one picks up what's left.

1. **Name one scope.** One sentence, mechanical, with a list that ends, about 10 items at most. Example: watch PRs #12, #15 and #18; for each one that goes green, collect its head SHA and check state; send a batch when about 10 are ready. If the work needs a decision, it is not butler work: do it yourself.

2. **Read the configured selection.** Run `bun {{chamberlain}}/src/models.ts selection butler`. Its JSON contains `server` and `launch`, validated against that server's provider catalog. Missing configuration, credentials, capabilities or quota stops the launch; keep the work pending with the Steward. Only the operator changes the model or effort in `config.json`.

3. **Resolve the configured machine.** Use `launch.environmentId` for T3 calls and select the intended project's ID on that exact environment. If the environment or project is unavailable, stop and report it; retain the work, with no alternate machine or model. Note any tools that machine lacks in the brief.

4. **Launch it.** One `t3_thread_launch` with:
   - `title: "Butler: <scope in four words>"`
   - `environmentId` and `modelSelection` copied exactly from `launch`, including every option
   - `projectId` verified on that environment
   - `workspaceStrategy: {type: "root"}`
   - one fresh `clientRequestId`, reused if this same launch needs reconciliation
   - `message` set to the brief below, filled in

5. **Record it after T3 confirms the launch.** `bun {{chamberlain}}/src/core/ops/butler.ts start --thread <new thread id> --machine <server from step 2> --model <launch.modelSelection.model> --scope "<scope>"`. It prints the butler id; put that id in the title or your notes. `bun {{chamberlain}}/src/core/ops/butler.ts list` shows who is live. Check it before starting another one for the same scope. An ambiguous launch is reconciled through its existing request id before another is attempted.

6. **Stopping.** To stop one, `t3_thread_send` it the word `stop`, then `bun {{chamberlain}}/src/core/ops/butler.ts stop <id> --reason "<why>"`. When a butler reports it has archived itself, record the stop the same way.

## When a butler or a worker gets stuck

Have it run the relevant check and compare the evidence with its report. If the configured model cannot complete the work, return the work and evidence to the Steward. A model, effort or machine change requires an operator update to the central selection; a new job then reads and validates that selection again.

## The brief

Fill in the angle brackets and send it as the message.

> You are a butler for the Steward. You do one narrow job and nothing else.
>
> **Your job:** <scope>
> **Your list:** <PRs or items, each with its repo and URL>
> **Steward thread:** <thread id> on environment <environment id>. Send everything to it with `t3_thread_send`, mode `queue`.
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
