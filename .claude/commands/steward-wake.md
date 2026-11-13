---
description: A Chamberlain wake for the Steward
---
Handle this wake as your hand-off says.

A wake carries a delivery id (its last line, `delivery id: ...`). The webhook cannot de-duplicate, so you do: if you have already handled a wake with that delivery id, treat this one as a repeat. Say "repeat of <delivery id>" in one line and do nothing else. Never act twice on one delivery id.

$ARGUMENTS
