# Examples

Copy what you need into `~/.config/chamberlain/` and make it private; Chamberlain refuses a secret that is readable by others, and a
`config.json` that others can write:

```sh
install -m 600 examples/config.json ~/.config/chamberlain/config.json
install -m 600 examples/decision-rights.md ~/.config/chamberlain/decision-rights.md
install -d -m 700 ~/.config/chamberlain/secrets
```

| File | Goes to | Notes |
| --- | --- | --- |
| `config.json` | `config.json` | Every setting that is not a secret, in one file: your name, an alert command, the thread ids, two servers (the Steward's own, and a laptop reached over a tunnel), the Decisions page and a routine check. Without a `servers` list there is one server named `local`. For the page, `web.host` must be loopback or a Tailscale address; the other keys are optional. Replace the `REPLACE-WITH-...` values and delete what you do not use. |
| `sweep-check.sh` | wherever `sweep.checks` points | A routine check that prints findings as JSON. The command is run directly, not through a shell. |
| `decision-rights.md` | `decision-rights.md` | The Steward's standing rules, in your words. |
| `operating-rules.json` | the `operatingRules` key of `config.json` | Which lines of your own rules files the Steward's hand-off copies in: sections, chosen lines and a host table, from two sources. Paste its contents as the value (leave `schemaVersion` out). |
| `brief.d/10-landing.md` | `brief.d/10-landing.md` | A brief fragment: a section of your own, appended to the Steward's hand-off. |

Secrets (`read-token`, `operate-token`, ...) go in `~/.config/chamberlain/secrets/`, one file per token, and are created with the `t3 auth session issue`
command shown in the README's first-wake steps; they are never kept in this repository.
