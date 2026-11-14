/** The Alert Desk's command allowlist: the checks for journalctl, systemctl, docker and the simple commands. */
import { GENERIC_SHAPES, type ShapeSet } from "./core/desk-shapes.ts";
import { DIGITS, isVerdict, parse, type Spec, TIME, UNIT, verdictOf } from "./desk-parse.ts";
import { checkShape } from "./desk-shape.ts";
import { no, ok, type Verdict } from "./desk-verdict.ts";

/** `docker inspect --format` and `docker ps --format`: literal text and `{{.Field}}` for these fields only. No `json`, no `range`, no object that holds the environment. */
const INSPECT_FIELDS = [
	"Name",
	"RestartCount",
	"State.Status",
	"State.Running",
	"State.Restarting",
	"State.OOMKilled",
	"State.ExitCode",
	"State.StartedAt",
	"State.FinishedAt",
	"State.Health.Status",
	"Config.Image",
	"HostConfig.RestartPolicy.Name",
	"Created",
];
const PS_FIELDS = ["Names", "Status", "State", "Image", "RunningFor", "ID", "CreatedAt", "Ports"];
const formatOk = (fmt: string, fields: string[]) =>
	new RegExp(`^(?:[^{}$\`\\\\]|\\{\\{\\.(?:${fields.map((f) => f.replace(/\./g, "\\.")).join("|")})\\}\\})*$`).test(
		fmt,
	) && fmt.length <= 300;
const inspectFormat = (v: string) => formatOk(v, INSPECT_FIELDS);
const psFormat = (v: string) => formatOk(v, PS_FIELDS);

// ---- the command shapes ------------------------------------------------------------------------------

/** A journald priority, a name or 0-7, or a range of two (`warning..emerg`). Anything else journalctl would refuse, so it is refused here. */
const PRIO = "(?:emerg|alert|crit|err|warning|notice|info|debug|[0-7])";
const PRIORITY = new RegExp(`^${PRIO}(?:\\.\\.${PRIO})?$`);
const OUTPUT = /^(short|short-iso|short-precise|cat)$/;
const journalctl: Spec = {
	flags: {
		"--user": "bool",
		"--no-pager": "bool",
		"-r": "bool",
		"--reverse": "bool",
		"-u": UNIT,
		"--unit": UNIT,
		"-n": DIGITS,
		"--lines": DIGITS,
		"--since": TIME,
		"--until": TIME,
		"-p": PRIORITY,
		"--priority": PRIORITY,
		"-o": OUTPUT,
		"--output": OUTPUT,
	},
	same: { "--reverse": "-r", "--unit": "-u", "--lines": "-n", "--priority": "-p", "--output": "-o" },
};
const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;

const SYSTEMCTL: Spec = {
	flags: {
		"--user": "bool",
		"--no-pager": "bool",
		"-l": "bool",
		"--full": "bool",
		"-n": DIGITS,
		"--lines": DIGITS,
		"--failed": "bool",
	},
	same: { "--full": "-l", "--lines": "-n" },
	positional: UNIT,
};
const SYSTEMCTL_VERBS = ["status", "is-active", "is-failed", "list-units"];

function checkSystemctl(args: string[]): Verdict {
	const r = parse(args, SYSTEMCTL, "systemctl");
	if (isVerdict(r)) return r;
	const [sub, ...units] = r.pos;
	if (!sub || !SYSTEMCTL_VERBS.includes(sub))
		return no(
			`systemctl: only status, is-active, is-failed and list-units are allowed (not ${JSON.stringify(sub ?? "")}); cat and show print unit files and environments`,
		);
	if (sub === "list-units" && units.length) return no("systemctl list-units takes no unit");
	if (sub !== "list-units" && units.length === 0) return no(`systemctl ${sub} needs a unit`);
	return ok;
}

const DOCKER_PS: Spec = {
	flags: { "-a": "bool", "--all": "bool", "--no-trunc": "bool", "--format": psFormat },
	same: { "--all": "-a" },
	max: 0,
};
const DOCKER_LOGS: Spec = {
	flags: { "--tail": DIGITS, "--since": TIME, "--until": TIME, "-t": "bool", "--timestamps": "bool" },
	same: { "--timestamps": "-t" },
	positional: CONTAINER,
	max: 1,
	min: 1,
};
// One --format, in one spelling, and it is checked as it is parsed: `--format A --format B` and `-f A --format=B` are both refused.
const DOCKER_INSPECT: Spec = {
	flags: { "--format": inspectFormat, "-f": inspectFormat },
	same: { "--format": "-f" },
	positional: CONTAINER,
	min: 1,
	max: 6,
};

function checkDocker(args: string[]): Verdict {
	const [sub, ...rest] = args;
	if (sub === "ps") return verdictOf(parse(rest, DOCKER_PS, "docker ps"));
	if (sub === "logs") return verdictOf(parse(rest, DOCKER_LOGS, "docker logs"));
	if (sub === "inspect") {
		const r = parse(rest, DOCKER_INSPECT, "docker inspect");
		if (isVerdict(r)) return r;
		return "-f" in r.flag
			? ok
			: no("docker inspect: a --format is required, because the full document holds the container's environment");
	}
	return no("docker: only ps, logs and inspect are allowed");
}

export function checkSimple(tokens: string[], shapes: ShapeSet): Verdict {
	const [name, ...args] = tokens;
	if (!name || name.includes("/") || name.includes("="))
		return no("the command must be a bare name from the allowlist");
	if (name === "journalctl") return verdictOf(parse(args, journalctl, "journalctl"));
	if (name === "systemctl") return checkSystemctl(args);
	if (name === "docker") return checkDocker(args);
	const shape = GENERIC_SHAPES[name] ?? shapes[name];
	return shape ? checkShape(name, args, shape) : no(`${JSON.stringify(name.slice(0, 40))} is not on the allowlist`);
}
