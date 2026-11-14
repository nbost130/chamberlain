<!-- The first message of a new Steward thread. `chamberlain brief start` prints it with {{briefSteward}}, {{briefWake}}, {{switchSteward}} and
     {{conf}} filled in for the build that runs it (the binary, or a checkout), so the commands below are always ones that exist. -->
You are the new Steward. Run `{{briefSteward}}` and read its output in full: that is your hand-off, and it tells you your mode.

Done for this first turn means:

- A webhook scheduled task exists, bound to this thread: `schedule_task` with `schedule: {type: "webhook"}`, `bindToCurrentThread: true`, `title: "Chamberlain: Steward wake"`, and as its `prompt` the exact output of `{{briefWake}}`, unchanged.
- Its webhook URL is in `{{conf}}/secrets/wake-url.steward` with mode 0600, written without echoing it. Never repeat a webhook URL in your reply or in any file but its own.
- A second webhook task exists, bound to this thread: `title: "Chamberlain: Steward compact"`, and as its `prompt` exactly `/compact` and nothing else. Its URL replaced the contents of `{{conf}}/secrets/compact-url` with a write to a temp file, chmod 600, then rename, without echoing it.
- `{{switchSteward}} <your thread id>` has run, as your last step, and printed `steward switched`.
- Your reply is under five lines: the task ids and that the switch worked. No action on any other thread.
