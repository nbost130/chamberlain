/** Checking that an adapter meets the contract: the capabilities it must have and the ones it may. */
import type { Adapter, OptionalCapability } from "./adapter.ts";

/** True when the adapter declares the capability. The type guard says which method is then present. */
export function has<K extends OptionalCapability>(
	a: Adapter,
	cap: K,
): a is Adapter & Required<Pick<Adapter, CapabilityMethod[K]>> {
	return a.capabilities.includes(cap);
}
type CapabilityMethod = {
	answer: "answer";
	listWaiting: "listWaiting";
	setTitle: "setTitle";
	transcriptPath: "transcriptPath";
	inspect: "inspect";
	send: "send";
	stewardProbe: "stewardProbe";
	compact: "compact";
	snapshot: "snapshot";
	alertDesk: "alertDesk";
	handoffInstruction: "handoffInstruction";
	threadLinks: "threadLinks";
};

/** What is missing of the parts every adapter must have: an id, `watch`, `isBusy`, `post`, and a `wake` with `ready` and `send`. */
function requiredProblems(a: Adapter): string[] {
	const bad: string[] = [];
	if (!a.id) bad.push("no id");
	for (const m of ["watch", "isBusy", "post"] as const)
		if (typeof a[m] !== "function") bad.push(`required method ${m} is missing`);
	if (!a.wake || typeof a.wake.ready !== "function" || typeof a.wake.send !== "function")
		bad.push("required capability wake needs ready() and send()");
	return bad;
}

/** Where declared capabilities and implemented methods disagree, and any declared capability that does not exist. */
function capabilityProblems(a: Adapter): string[] {
	const bad: string[] = [];
	const methods: Record<OptionalCapability, unknown> = {
		answer: a.answer,
		listWaiting: a.listWaiting,
		setTitle: a.setTitle,
		transcriptPath: a.transcriptPath,
		inspect: a.inspect,
		send: a.send,
		stewardProbe: a.stewardProbe,
		compact: a.compact,
		snapshot: a.snapshot,
		alertDesk: a.alertDesk,
		handoffInstruction: a.handoffInstruction,
		threadLinks: a.threadLinks,
	};
	for (const [cap, impl] of Object.entries(methods)) {
		const declared = a.capabilities.includes(cap as OptionalCapability);
		if (declared && !impl) bad.push(`declares ${cap} but does not implement it`);
		if (!declared && impl) bad.push(`implements ${cap} but does not declare it`);
	}
	for (const cap of a.capabilities) if (!(cap in methods)) bad.push(`declares unknown capability ${cap}`);
	return bad;
}

/** Pure: what is wrong with an adapter's declaration, or an empty list. Every adapter test (and the fake's) runs it. */
export function conformance(a: Adapter): string[] {
	return [...requiredProblems(a), ...capabilityProblems(a)];
}
