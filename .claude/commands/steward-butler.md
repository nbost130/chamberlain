---
description: Start a butler, a cheap helper thread for one narrow piece of mechanical work
---

<!-- TEMPLATE. Copy to your Steward project's .claude/commands/ and fill in the {{...}} placeholders for your setup.
     {{chamberlain}} is the path of your Chamberlain checkout. -->

Start a butler. When a subset of work is mechanical, spawn one and give it the cheapest model that fits. Do these in order and stop at the first step that fails. `$ARGUMENTS` may name the work; if it doesn't, pick it yourself.

A butler is a short job, never a standing thread. Each one gets a short list, finishes it and archives itself. For more work, start a fresh butler. A long conversation costs more on every turn, so a butler kept alive all day loses the saving it exists for. A butler still running after 2 hours, or past about 30 turns, gets `stop`, and a fresh one picks up what's left.

1. **Name one scope.** One sentence, mechanical, with a list that ends, about 10 items at most. Example: watch PRs #12, #15 and #18; for each one that goes green, collect its head SHA and check state; send a batch when about 10 are ready. If the work needs a decision, it is not butler work: do it yourself.

2. **Pick the model.** The cheapest that fits.
   - A small model: watching, sorting, counting, reporting.
   - A mid-size model: the work has to read code or logs.
   - Anything harder stays with you.

   Run `orchestrator_capabilities` and copy the model ID and provider instance from its catalog, never from memory.

3. **Pick the machine.** Default: {{butler machine, with its environmentId and project id}}, so the load stays off the Steward's machine. Note anything that machine lacks (a container runtime, a tool) in the brief. Cross-machine `delegate_task` cannot use `isolation: "worktree"`; launch a worktree thread instead. If the default machine doesn't answer on `t3_environment_links`, use the Steward's machine. If neither answers, stop and tell the operator.

4. **Launch it.** One `t3_thread_launch` with:
   - `title: "Butler: <scope in four words>"`
   - the `environmentId` of that machine and `modelSelection` from step 2
   - `workspaceStrategy: {type: "root"}`
   - a fresh `clientRequestId`
   - `message` set to the brief below, filled in

5. **Record it.** `bun {{chamberlain}}/src/core/butler.ts start --thread <new thread id> --machine <name> --model <model> --scope "<scope>"`. It prints the butler id; put that id in the title or your notes. `bun {{chamberlain}}/src/core/butler.ts list` shows who is live. Check it before starting another one for the same scope.

6. **Stopping.** To stop one, `t3_thread_send` it the word `stop`, then `bun {{chamberlain}}/src/core/butler.ts stop <id> --reason "<why>"`. When a butler reports it has archived itself, record the stop the same way.

## When a butler or a worker gets stuck

Escalate in this order, and move to the next step only after the last one has failed:

1. **Make it check its own work.** Send it the exact check to run (a test, a re-read of the PR's checks) and have it compare the result with what it reported. Most stalls are a wrong reading, not a hard problem.
2. **Raise its effort.** Same model, more reasoning effort, restarted on the same short list.
3. **Move up a model.** From a small model to a mid-size one. From a mid-size one, the work comes back to you and is no longer butler work.

Each step is a fresh short job, not more turns in the stuck thread. Log the step and why in your notes.

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
