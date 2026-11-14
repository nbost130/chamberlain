import { describe, expect, test } from "bun:test";
import { describeShape, GENERIC_SHAPES, parseGatherer, parseShapes } from "./desk-shapes.ts";

const KINDS = "digits, word, unit, time, repo, ref";
const drop = (name: string, why: string) => `alert desk: ignoring the command shape ${JSON.stringify(name)}: ${why}`;
const parsed = (raw: unknown) => {
	const warned: string[] = [];
	return { shapes: parseShapes(raw, (m) => warned.push(m)), warned };
};

describe("parseShapes: what is dropped, and the one warning that says why", () => {
	const BAD_POSITIONAL = `has a \`positional\` that is neither a kind (${KINDS}) nor a list of plain words`;
	const NOT_JOIN = (k: string) => `has a \`same\` entry (${JSON.stringify(k)}) that does not join two flags it lists`;
	const table: [string, unknown, string][] = [
		["a body that is not an object", 5, "is not an object"],
		["an unknown field", { weird: 1 }, 'has an unknown field "weird"'],
		["an unknown field, cut at 40 characters", { ["w".repeat(60)]: 1 }, `has an unknown field "${"w".repeat(40)}"`],
		["flags that are not an object", { flags: 5 }, "has `flags` that is not an object"],
		[
			"a flag not written -x or --name",
			{ flags: { "bad flag": "bool" } },
			'has the flag "bad flag", which is not written -x or --name',
		],
		[
			"a flag name cut at 40 characters",
			{ flags: { ["-".repeat(60)]: "bool" } },
			`has the flag "${"-".repeat(40)}", which is not written -x or --name`,
		],
		[
			"a flag with an unknown value kind",
			{ flags: { "--a": "nope" } },
			`has the flag --a with a value kind that is not bool, ${KINDS}`,
		],
		["`same` that is not an object", { same: 5 }, "has `same` that is not an object"],
		["a `same` target that is not a string", { flags: { "--a": "bool" }, same: { "--a": 5 } }, NOT_JOIN("--a")],
		[
			"a `same` target that is not a listed flag",
			{ flags: { "--a": "bool" }, same: { "--a": "--b" } },
			NOT_JOIN("--a"),
		],
		["`same` with no flags at all", { same: { "--a": "--b" } }, NOT_JOIN("--a")],
		[
			"a `same` key that is not a flag name",
			{ flags: { "--a": "bool", "--b": "bool" }, same: { bad: "--b" } },
			NOT_JOIN("bad"),
		],
		["a positional that is neither a kind nor a list", { positional: 5 }, BAD_POSITIONAL],
		["an empty positional list", { positional: [] }, BAD_POSITIONAL],
		["a positional list of 21 words", { positional: Array(21).fill("a") }, BAD_POSITIONAL],
		["a positional word that is not plain", { positional: ["a b"] }, BAD_POSITIONAL],
		["a negative min", { min: -1 }, "has a `min` that is not a whole number from 0 to 20"],
		["a max above 20", { max: 21 }, "has a `max` that is not a whole number from 0 to 20"],
		["a fractional max", { max: 1.5 }, "has a `max` that is not a whole number from 0 to 20"],
		["`paths` that is not a boolean", { paths: "yes" }, "has `paths` that is not true or false"],
		["`bare` that is not a boolean", { bare: "y" }, "has `bare` that is not true or false"],
		["`subcommands` that is not an object", { subcommands: 5 }, "has `subcommands` that is not an object"],
		[
			"a subcommand that is not one or two lowercase words",
			{ subcommands: { "Bad Name": {} } },
			'the subcommand "Bad Name" is not one or two lowercase words',
		],
		["a subcommand body that is not an object", { subcommands: { ok: 5 } }, 'the subcommand "ok" is not an object'],
		[
			"a subcommand that has subcommands of its own",
			{ subcommands: { ok: { subcommands: {} } } },
			'the subcommand "ok" has an unknown field "subcommands"',
		],
	];
	for (const [what, body, why] of table)
		test(`${what}: the command is left out whole`, () => {
			const { shapes, warned } = parsed({ x: body });
			expect(shapes).toEqual({});
			expect(warned).toEqual([drop("x", why)]);
		});

	test("a commandShapes that is not an object is ignored", () => {
		for (const raw of [5, []]) {
			const { shapes, warned } = parsed(raw);
			expect(shapes).toEqual({});
			expect(warned).toEqual(["alert desk: ignoring commandShapes: it is not an object"]);
		}
		expect(parsed(undefined)).toEqual({ shapes: {}, warned: [] });
	});

	test("a name that is not a bare command, and a built-in command, are left out", () => {
		expect(parsed({ "bad name": {} })).toEqual({
			shapes: {},
			warned: [drop("bad name", "a command is a bare name")],
		});
		expect(parsed({ gh: {}, journalctl: {} }).warned).toEqual([
			drop("gh", "it is a built-in command, whose shape cannot be changed"),
			drop("journalctl", "it is a built-in command, whose shape cannot be changed"),
		]);
	});

	test("a bad command does not take a good one with it", () => {
		const { shapes, warned } = parsed({ good: { max: 1 }, bad: { max: 99 } });
		expect(shapes).toEqual({ good: { max: 1 } });
		expect(warned).toEqual([drop("bad", "has a `max` that is not a whole number from 0 to 20")]);
	});

	test("a whole shape is normalized: false flags are dropped, true ones kept, subcommands parsed", () => {
		const { shapes, warned } = parsed({
			x: {
				bare: true,
				flags: { "--a": "bool", "-b": "digits" },
				same: { "--a": "-b" },
				positional: ["one", "two"],
				min: 1,
				max: 3,
				paths: true,
				subcommands: {
					"run view": { flags: { "--r": "repo" }, positional: "digits", min: 1, max: 1 },
					list: { paths: false, max: 0 },
				},
			},
			y: { bare: false, paths: false },
		});
		expect(warned).toEqual([]);
		expect(shapes).toEqual({
			x: {
				flags: { "--a": "bool", "-b": "digits" },
				same: { "--a": "-b" },
				positional: ["one", "two"],
				min: 1,
				max: 3,
				paths: true,
				bare: true,
				subcommands: {
					"run view": { flags: { "--r": "repo" }, positional: "digits", min: 1, max: 1 },
					list: { max: 0 },
				},
			},
			y: {},
		});
	});
});

describe("parseGatherer", () => {
	const WARNING = "alert desk: ignoring `gatherer`: it is a plain agent name (letters, digits, `_`, `.`, `-`)";
	test("a plain name is kept, nothing is no name, and anything else is refused with one warning", () => {
		const warned: string[] = [];
		const warn = (m: string) => warned.push(m);
		expect(parseGatherer(undefined, warn)).toBeUndefined();
		expect(parseGatherer("ok-name", warn)).toBe("ok-name");
		expect(warned).toEqual([]);
		for (const bad of ["bad name", 5, "x".repeat(62)]) expect(parseGatherer(bad, warn)).toBeUndefined();
		expect(warned).toEqual([WARNING, WARNING, WARNING]);
	});
});

describe("describeShape: one line per thing a shape allows", () => {
	test("the shipped gh and git shapes", () => {
		expect(Object.entries(GENERIC_SHAPES).flatMap(([n, s]) => describeShape(n, s))).toEqual([
			"`gh run view [--repo <repo>] [--log-failed] <digits>`",
			"`gh run list [--repo <repo>] [--limit <digits>]`",
			"`gh pr checks [--repo <repo>] <digits>`",
			"`git status [-- <relative path>]`",
			"`git log [--stat] [--shortstat] [--name-only] [--name-status] [--oneline] [--no-color] [-n <digits>] [--since <time>] [--until <time>] [<ref>] [-- <relative path>]`",
			"`git diff [--stat] [--shortstat] [--name-only] [--name-status] [--oneline] [--no-color] [-n <digits>] [--since <time>] [--until <time>] [<ref>] [-- <relative path>]`",
		]);
	});

	test("a bare command, a flag spelled two ways, a word list, and the shapes of a bare name", () => {
		expect(
			describeShape("w", {
				bare: true,
				flags: { "--a": "bool", "--n": "digits", "-n": "digits" },
				same: { "--n": "-n" },
				positional: ["x", "y"],
				min: 1,
				paths: true,
			}),
		).toEqual(["`w`", "`w [--a] [-n <digits>] [x|y] [-- <relative path>]`"]);
		expect(describeShape("w", { positional: "ref", min: 1 })).toEqual(["`w <ref>`"]);
		expect(describeShape("w", { positional: "ref" })).toEqual(["`w [<ref>]`"]);
		expect(describeShape("w", {})).toEqual(["`w`"]);
	});
});
