import { expect, test } from "bun:test";
import { decisionsTitle, titleKeeper } from "./title.ts";

test("the title names the open count", () => {
	expect(decisionsTitle(0)).toBe("Decisions · clear");
	expect(decisionsTitle(2)).toBe("Decisions · 2 waiting");
});

test("the keeper renames only on a change, and retries until a rename lands", async () => {
	let open = 1;
	const calls: string[] = [];
	let outcome: "set" | "no-token" | "failed" = "no-token";
	const tick = titleKeeper(
		() => open,
		async (t) => {
			calls.push(t);
			return outcome;
		},
		() => {},
	);
	await tick(); // no token yet: tried, not remembered
	outcome = "set";
	await tick();
	await tick(); // unchanged: no call
	open = 0;
	await tick();
	expect(calls).toEqual(["Decisions · 1 waiting", "Decisions · 1 waiting", "Decisions · clear"]);
});

test("a throwing rename is logged and retried", async () => {
	const calls: string[] = [];
	const logged: string[] = [];
	let fail = true;
	const tick = titleKeeper(
		() => 3,
		async (t) => {
			calls.push(t);
			if (fail) throw Error("socket");
			return "set";
		},
		(e) => logged.push(e),
	);
	await tick();
	fail = false;
	await tick();
	await tick();
	expect(calls).toHaveLength(2);
	expect(logged).toContain("title-error");
	expect(logged).toContain("title-set");
});
