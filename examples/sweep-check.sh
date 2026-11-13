#!/bin/sh
# An example routine check for sweep.json: an item source. It prints a JSON array of findings on stdout and exits 0.
# A finding is {"dedupKey", "text", "repeatIntervalMs"?, "maxNotifications"?, "baseline"?, "subject"?}:
#   dedupKey   names the finding, and is unique within this check (PagerDuty calls it dedup_key). A new key is news;
#              one that is already there is the same finding.
#   text       what the Steward is told (outside text: it reaches the Steward fenced as untrusted data).
#   repeatIntervalMs   notify again this many milliseconds after each notification for as long as the finding is still reported
#              (0 means on every sweep). Leave it out to notify once.
#   maxNotifications  stop repeating after this many notifications (goes with repeatIntervalMs).
#   baseline   true if the very first sweep should learn it silently, as a standing condition rather than news.
#   subject    {"kind", "id"} for what it is about: a pull request, a run, a deploy.
# A finding that is no longer printed is resolved, so if it comes back it notifies again as new.
# Exit non-zero (or print something that is not a JSON array) and the check is in error: the sweep is then
# made a full one, because a check that cannot run must never read as a clear one.
# In sweep.json a check can also carry "mode": "shadow" to record what it would have sent without waking anyone,
# or "silenced" to track it and never notify.
set -eu
free_kb=$(df -k / | awk 'NR==2 {print $4}')
free_gib=$((free_kb / 1024 / 1024))
if [ "$free_gib" -lt 20 ]; then
  printf '[{"dedupKey":"disk-low","repeatIntervalMs":0,"text":"Only %s GiB free on /. Tell builders to start no new writers."}]\n' "$free_gib"
else
  printf '[]\n'
fi
