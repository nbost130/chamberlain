import { expect, test } from "bun:test";
import { readClaim } from "../core/items/questions-claim.ts";
import { run, settle } from "../testing/inline-dom.ts";
import { useWebAppPathsFixtures } from "../testing/web-app-paths-fixtures.ts";
import { detail } from "../testing/web-app-view-fixtures.ts";
import { item } from "../testing/web-inline-view-fixtures.ts";

const { question, setup } = useWebAppPathsFixtures();

const cases = [
	["**bold** and `code`", "<strong>bold</strong> and <code>code</code>", "bold and code"],
	["<img onerror> <script>", "&lt;img onerror&gt; &lt;script&gt;", "<img onerror> <script>"],
	['" autofocus="', "&quot; autofocus=&quot;", '" autofocus="'],
	["**<b>**", "<strong>&lt;b&gt;</strong>", "<b>"],
	["`<b>**literal**`", "<code>&lt;b&gt;**literal**</code>", "<b>**literal**"],
	["**bold with `literal code`**", "<strong>bold with `literal code`</strong>", "bold with `literal code`"],
	["**unbalanced and `unfinished", "**unbalanced and `unfinished", "**unbalanced and `unfinished"],
	["**** ** **", "**** ** **", "**** ** **"],
	["``", "``", "``"],
	["[link](javascript:void(0))", "[link](javascript:void(0))", "[link](javascript:void(0))"],
] as const;

test.each(cases)("queue and inline render %s as inert text with only bold and code", async (raw, html, plain) => {
	const context = `Intro\n- ${raw}`;
	const options = [{ label: raw, detail: raw }, { label: "Other" }];
	const page = await detail(context, { options });
	expect(page).toContain(`<li>${html}</li>`);
	expect(page).toContain(`<span class="lbl">${html}<span class="rec">`);
	expect(page).toContain(`<span class="det">${html}</span>`);
	const selectedCard = page.split('aria-label="Selected decision">')[1]!;
	expect(selectedCard).not.toMatch(/<img onerror|<script>|<b>|\shref="javascript:|\sautofocus="/);
	const dq = run(() => ({ items: [{ ...item(context), options }] }));
	await settle();
	for (const selector of ["li", ".dq-l", ".dq-d"]) {
		const node = dq.querySelector(selector)!;
		expect(node.textContent).toBe(plain);
		expect(node.children.filter((el) => el.tag !== "span").map((el) => el.tag)).toEqual(
			[...html.matchAll(/<(strong|code)>/g)].map((m) => m[1]),
		);
	}
	expect(dq.querySelector(".dq-confirm")?.attrs["aria-label"]).toBe(`Answer: ${plain}`);
	expect(dq.all((el) => ["img", "script", "b", "a"].includes(el.tag))).toEqual([]);
});

test("both views put plain multiline references in a native collapsed Details toggle", async () => {
	const details = "  **ref** <b>\n\tpath/to/file";
	const page = await detail("Context", { details });
	expect(page).toContain(
		'<details class="technical-details"><summary>Details</summary><pre>\n  **ref** &lt;b&gt;\n\tpath/to/file</pre></details>',
	);
	const dq = run(() => ({ items: [{ ...item("Context"), details }] }));
	await settle();
	const disclosure = dq.querySelector(".dq-details")!;
	expect(disclosure.tag).toBe("details");
	expect(disclosure.open).toBe(false);
	expect(disclosure.querySelector("summary")?.textContent).toBe("Details");
	expect(disclosure.querySelector("pre")?.textContent).toBe(details);
	expect(disclosure.querySelector("pre")?.children).toEqual([]);
});

test("older and secret cards show no Details toggle", async () => {
	const secret = { secret: true, options: [], details: "WITHHELD-DETAILS" };
	expect(await detail("Context")).not.toContain('class="technical-details"');
	const redacted = await detail("", secret);
	expect(redacted).not.toContain('class="technical-details"');
	expect(redacted).not.toContain(secret.details);
	const dq = run(() => ({ items: [item("Context"), { ...item(""), id: "Q-secret", ...secret }] }));
	await settle();
	expect(dq.querySelector(".dq-details")).toBeNull();
	expect(dq.textContent).not.toContain(secret.details);
});

test("the rendered label never replaces the filed value in the answer, wake or relay", async () => {
	const label = "**Continue** with `stage`";
	const relay = "Keep **this** wording.";
	const messages: string[] = [];
	const s = setup({
		send: async (_server, _thread, message) => {
			messages.push(message);
			return { ok: false, detail: "Synthetic refusal" };
		},
	});
	const id = "Q-filed";
	s.asked(question(id, { options: [{ label, route: "thread", relay }, { label: "Hold" }] }));
	expect((await s.post(`/api/items/${id}/answer`, { choice: 0 })).status).toBe(200);
	await s.app.idle();
	const claim = readClaim(s.real, id);
	expect(claim?.answer?.label).toBe(label);
	expect(claim?.message).toContain(`choice: 1. ${label}\n`);
	expect(messages).toHaveLength(1);
	expect(messages[0]).toContain(`Their choice: ${label}\nWhat to do: ${relay}`);
});
