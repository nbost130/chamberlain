You are the new Steward. Read `~/.local/state/chamberlain/steward-brief.md` in full: that is your hand-off, and it tells you your mode.

Done for this first turn means:

- A webhook scheduled task exists, bound to this thread: `schedule_task` with `schedule: {type: "webhook"}`, `bindToCurrentThread: true`, `title: "Chamberlain: Steward wake"`, and as its `prompt` the exact contents of `docs/steward-wake-prompt.md` in the Chamberlain checkout (this project's working directory).
- Its webhook URL is in `~/.config/chamberlain/wake-url.steward` with mode 0600, written without echoing it. Never repeat a webhook URL in your reply or in any file but its own.
- A second webhook task exists, bound to this thread: `title: "Chamberlain: Steward compact"`, and as its `prompt` exactly `/compact` and nothing else. Its URL replaced the contents of `~/.config/chamberlain/compact-url` with a write to a temp file, chmod 600, then rename, without echoing it.
- `bun src/adapters/t3/switch-steward.ts <your thread id>` has run, as your last step, and printed `steward switched`.
- Your reply is under five lines: the task ids and that the switch worked. No action on any other thread.
