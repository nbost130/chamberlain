# Examples

Copy what you need into `~/.config/chamberlain/` and make it private; Chamberlain refuses a config that is readable by
others:

```sh
install -m 600 examples/settings.json ~/.config/chamberlain/settings.json
install -m 600 examples/decision-rights.md ~/.config/chamberlain/decision-rights.md
```

| File | Goes to | Notes |
| --- | --- | --- |
| `settings.json` | `settings.json` | Your name, the T3 base directory, an alert command, the compaction threshold. |
| `servers.json` | `servers.json` | Two servers: the Steward's own, and a laptop reached over a tunnel. Without this file there is one server named `local`. |
| `web.json` | `web.json` | The Decisions page. `host` must be loopback or a Tailscale address; the other keys are optional. |
| `sweep.json` + `sweep-check.sh` | `sweep.json` | A routine check that prints findings as JSON. The command is run directly, not through a shell. |
| `decision-rights.md` | `decision-rights.md` | The Steward's standing rules, in your words. |
| `operating-rules.json` | `operating-rules.json` | Which lines of your own rules files the Steward's hand-off copies in: sections, chosen lines and a host table, from two sources. |
| `brief.d/10-landing.md` | `brief.d/10-landing.md` | A brief fragment: a section of your own, appended to the Steward's hand-off. |

Token files (`read-token`, `operate-token`, ...) hold one token each and are created with the `t3 auth session issue`
command shown in the README's first-wake steps; they are never kept in this repository.
