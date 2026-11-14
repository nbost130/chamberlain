/**
 * Builds the standalone binaries: `bun scripts/build.ts [--out dist] [--targets linux-x64,darwin-arm64,...]`.
 *
 * One `bun build --compile` per target, all from this one machine (Bun cross-compiles; it downloads each target's runtime once). Each binary is
 * `chamberlain` from src/cli.ts, with src/web/static/ and the prompt docs embedded (src/embedded.ts), so it needs no Bun and no checkout.
 * Per target it writes `chamberlain-<version>-<os>-<arch>.tar.gz` (the binary, LICENSE and README.md) and its `.sha256`, and one
 * `SHA256SUMS` over all of them, in the format `sha256sum -c` reads. The release workflow uploads these, and scripts/render-formula.ts
 * reads SHA256SUMS to fill the Homebrew formula.
 */
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };

/** The four platforms the release ships: our `<os>-<arch>` name, and Bun's compile target for it. */
export const TARGETS = {
	"linux-x64": "bun-linux-x64",
	"linux-arm64": "bun-linux-arm64",
	"darwin-arm64": "bun-darwin-arm64",
	"darwin-x64": "bun-darwin-x64",
} as const;
export type Target = keyof typeof TARGETS;

/** The tarball's name for a target: the same string the formula's `url` and the SHA256SUMS line use. */
export const tarballName = (version: string, target: string) => `chamberlain-${version}-${target}.tar.gz`;

const ROOT = resolve(import.meta.dir, "..");
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

function run(cmd: string[], cwd = ROOT) {
	const p = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
	if (p.exitCode !== 0) throw Error(`${cmd.join(" ")} exited ${p.exitCode}`);
}

/** Builds one target's binary into `dir` and returns its path. */
export function compile(target: Target, dir: string): string {
	const outfile = join(dir, "chamberlain");
	run(["bun", "build", "--compile", `--target=${TARGETS[target]}`, "--outfile", outfile, "src/cli.ts"]);
	return outfile;
}

export function main(argv: string[] = process.argv.slice(2)) {
	const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
	const out = resolve(ROOT, flag("--out") ?? "dist");
	const wanted = (flag("--targets")?.split(",").map((t) => t.trim()).filter(Boolean) ?? Object.keys(TARGETS)) as Target[];
	for (const t of wanted) if (!(t in TARGETS)) throw Error(`unknown target ${t}; one of ${Object.keys(TARGETS).join(", ")}`);
	mkdirSync(out, { recursive: true });
	const sums: string[] = [];
	for (const target of wanted) {
		const stage = mkdtempSync(join(tmpdir(), `chamberlain-build-${target}-`));
		try {
			compile(target, stage);
			for (const f of ["LICENSE", "README.md"]) copyFileSync(join(ROOT, f), join(stage, f));
			const name = tarballName(pkg.version, target);
			// A plain tar of three files: the binary at the top, so `bin.install "chamberlain"` finds it after the extract.
			run(["tar", "-czf", join(out, name), "-C", stage, "chamberlain", "LICENSE", "README.md"]);
			const sum = sha256(join(out, name));
			writeFileSync(join(out, `${name}.sha256`), `${sum}  ${name}\n`);
			sums.push(`${sum}  ${name}`);
			console.log(`${name}  ${sum}`);
		} finally { rmSync(stage, { recursive: true, force: true }); }
	}
	// Written whole, in target order, so the file is the same for the same inputs. A partial `--targets` run writes a partial SHA256SUMS.
	writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
	console.log(`wrote ${join(out, "SHA256SUMS")} (${sums.length} file${sums.length === 1 ? "" : "s"})`);
}

if (import.meta.main) main();
