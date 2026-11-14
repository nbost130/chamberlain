/**
 * Renders the Homebrew formula: `bun scripts/render-formula.ts --sums dist/SHA256SUMS [--version X.Y.Z] [--repo owner/name] [--out Formula/chamberlain.rb]`.
 * The template is packaging/homebrew/chamberlain.rb.tmpl; the checksums are the release's SHA256SUMS (scripts/build.ts). It refuses to render
 * with a platform missing from the sums, so a formula never goes out with a blank or stale checksum. Prints to stdout without `--out`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import pkg from "../package.json" with { type: "json" };
import { TARGETS, tarballName } from "./build.ts";

const ROOT = resolve(import.meta.dir, "..");

/** Pure: `sha256sum` output as { file name: hex digest }. */
export function parseSums(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const m = line.match(/^([0-9a-f]{64}) [ *](\S+)$/);
		if (!m) throw Error(`SHA256SUMS: cannot read the line "${line.slice(0, 80)}"`);
		out[m[2]!] = m[1]!;
	}
	return out;
}

/** Pure: the formula for `version`, from the template and the sums. */
export function render(template: string, version: string, sums: Record<string, string>, repo: string): string {
	let out = template.replaceAll("{{version}}", version).replaceAll("{{repo}}", repo);
	for (const target of Object.keys(TARGETS)) {
		const name = tarballName(version, target);
		const sum = sums[name];
		if (!sum) throw Error(`SHA256SUMS has no entry for ${name}: the formula needs all ${Object.keys(TARGETS).length} platforms`);
		out = out.replaceAll(`{{url:${target}}}`, `https://github.com/${repo}/releases/download/v${version}/${name}`).replaceAll(`{{sha256:${target}}}`, sum);
	}
	const left = out.match(/\{\{[^}]*\}\}/);
	if (left) throw Error(`the template still has ${left[0]} after rendering`);
	return out;
}

export function main(argv: string[] = process.argv.slice(2)) {
	const flag = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
	const sumsFile = flag("--sums");
	if (!sumsFile) { console.error("usage: bun scripts/render-formula.ts --sums <SHA256SUMS> [--version X.Y.Z] [--repo owner/name] [--out <file>]"); process.exit(2); }
	const formula = render(readFileSync(resolve(ROOT, "packaging/homebrew/chamberlain.rb.tmpl"), "utf8"), flag("--version") ?? pkg.version, parseSums(readFileSync(sumsFile, "utf8")), flag("--repo") ?? "nbost130/chamberlain");
	const out = flag("--out");
	if (!out) { process.stdout.write(formula); return; }
	mkdirSync(dirname(resolve(out)), { recursive: true });
	writeFileSync(out, formula);
	console.log(`wrote ${out}`);
}

if (import.meta.main) main();
