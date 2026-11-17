/** Review round on #100: a receipt comes only from a webhook delivery's exact template, with T3's completion time. */
import { describe, expect, test } from "bun:test";
import { useStewardSwitchFixtures } from "../../testing/steward-switch-fixtures.ts";
import { fakeT3 } from "../../testing/steward-switch-t3-fixtures.ts";
import { findReceipt, renderFencedWake } from "./receipts.ts";

const { scratch } = useStewardSwitchFixtures();

describe("receipts come only from a webhook delivery's exact template", () => {
	test("another scheduled prompt quoting the wake, or one that ends in prose, is no receipt", () => {
		const t3 = fakeT3(`${scratch()}/t3.sqlite`);
		const at = Date.now();
		// A scheduled prompt that is not a webhook delivery, quoting R's wake word for word.
		t3.seedCompletedWake({
			threadId: "th",
			deliveryId: "R",
			messageId: "scheduled-task-message:scheduled-task:nightly:cron:1",
		});
		expect(findReceipt(t3.path, { outboxId: 1, deliveryId: "R", landedAt: at, threads: ["th"] })).toBeUndefined();
		// A webhook delivery whose text quotes R's wake and then goes on in prose.
		const quoted = `${renderFencedWake("x", "R", "Q1")}\nand then the thread wrote more.`;
		t3.addMessage({
			messageId: "scheduled-task-message:t:webhook:delivery:relay:2",
			threadId: "th2",
			text: quoted,
			scheduledTaskId: "t",
		});
		t3.addRun({
			runId: "r2",
			threadId: "th2",
			status: "completed",
			userMessageId: "scheduled-task-message:t:webhook:delivery:relay:2",
			completedAt: new Date(at).toISOString(),
		});
		expect(findReceipt(t3.path, { outboxId: 1, deliveryId: "R", landedAt: at, threads: ["th2"] })).toBeUndefined();
		t3.close();
	});

	test("a run with no completion time gives no receipt", () => {
		const t3 = fakeT3(`${scratch()}/t3.sqlite`);
		const id = "scheduled-task-message:t:webhook:delivery:relay:3";
		t3.addMessage({ messageId: id, threadId: "th", text: renderFencedWake("x", "R", "Z9"), scheduledTaskId: "t" });
		t3.addRun({ runId: "r3", threadId: "th", status: "completed", userMessageId: id });
		expect(
			findReceipt(t3.path, { outboxId: 1, deliveryId: "R", landedAt: Date.now(), threads: ["th"] }),
		).toBeUndefined();
		t3.close();
	});
});
