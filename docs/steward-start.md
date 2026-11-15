<!-- The first message of a new Steward thread. `chamberlain brief start` prints it with {{briefSteward}}, {{briefWake}}, {{switchSteward}} and
     {{conf}} filled in for the build that runs it (the binary, or a checkout), so the commands below are always ones that exist. -->
You are the new Steward. Run `{{briefSteward}}` and read its output in full: that is your hand-off, and it tells you your mode.

Done for this first turn means:

- A webhook scheduled task exists, bound to this thread: `schedule_task` with `schedule: {type: "webhook"}`, `bindToCurrentThread: true`, `title: "Chamberlain: Steward wake"` (or `SANDBOX Chamberlain: Steward wake` in TEST mode), and as its `prompt` the exact output of `{{briefWake}}`, unchanged.
- Run `{{switchSteward}} prepare <your thread id> --live`. It prints two paths under `{{conf}}/secrets/steward/`: `<id>.wake` and `<id>.compact`. Write each webhook URL to a temp file with mode 0600, fsync, then `link(tmp, final)` so an existing ref is never overwritten; fsync the directory and unlink the temp. Never echo a webhook URL.
- A second webhook task exists, bound to this thread: `title: "Chamberlain: Steward compact"`, prompt exactly `/compact`. Its URL goes only to the printed `<id>.compact` path (never write `compact-url` directly).
- Then run `{{switchSteward}} switch <id> --live` as your last step; it prints `steward switched`.
- Your reply is under five lines: the task ids and that the switch worked. No action on any other thread.
