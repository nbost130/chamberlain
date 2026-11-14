import { expect, test } from "bun:test";
import { flagReader } from "./args.ts";

test("flagReader gives the value after the flag", () => {
	const flag = flagReader(["--out", "dist", "--targets", "linux-x64"]);
	expect(flag("--out")).toBe("dist");
	expect(flag("--targets")).toBe("linux-x64");
});

test("flagReader gives undefined for an absent flag or a flag with nothing after it", () => {
	const flag = flagReader(["--out", "dist", "--last"]);
	expect(flag("--missing")).toBeUndefined();
	expect(flag("--last")).toBeUndefined();
});
