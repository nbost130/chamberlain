/** One-time relocation of explicit model selections, inside the existing locked config migration. */
import type { Plan } from "./config-plan.ts";
import { isObject } from "./layout-schema.ts";

export function migrateModels(plan: Plan): void {
	const doc = plan.config;
	if (doc.models === null) return;
	const selections = isObject(doc.models) ? structuredClone(doc.models) : {};
	moveClassifier(plan, selections);
	const mail = isObject(doc.mail) ? structuredClone(doc.mail) : undefined;
	if (mail && isObject(mail.models)) moveMail(mail, selections, plan);
	if (Object.keys(selections).length && JSON.stringify(selections) !== JSON.stringify(doc.models)) {
		doc.models = selections;
		plan.writeConfig = true;
	}
}

function moveClassifier(plan: Plan, selections: Record<string, unknown>): void {
	const doc = plan.config;
	const sweep = isObject(doc.sweep) ? structuredClone(doc.sweep) : undefined;
	const idle = sweep && isObject(sweep.idleParents) ? sweep.idleParents : undefined;
	const classifier = idle && isObject(idle.classifier) ? idle.classifier : undefined;
	if (classifier?.provider !== "haiku") return;
	const old = isObject(classifier.haiku) ? classifier.haiku : {};
	if (!Object.hasOwn(selections, "classifier") && (!old.command || !old.model)) {
		plan.problems.push(
			"classifier: choose models.classifier explicitly; legacy selection relied on implicit Claude defaults",
		);
		return;
	}
	if (!Object.hasOwn(selections, "classifier"))
		selections.classifier = {
			adapter: "claude-cli",
			command: old.command,
			model: old.model,
			timeoutMs: old.timeoutMs ?? 60_000,
		};
	classifier.provider = "model";
	delete classifier.haiku;
	doc.sweep = sweep;
	plan.added.push({ key: "models.classifier", from: "sweep.idleParents.classifier.haiku" });
}

function moveMail(mail: Record<string, unknown>, selections: Record<string, unknown>, plan: Plan): void {
	const old = mail.models as Record<string, unknown>;
	const slots = { driver: "mailDriver", escalate: "mailEscalate", top: "mailTop" };
	for (const [legacy, role] of Object.entries(slots)) {
		if (!old[legacy] || old[legacy] === "none" || Object.hasOwn(selections, role)) continue;
		if (!old.command) {
			plan.problems.push(`mail.models.${legacy}: set an explicit command before migrating`);
			return;
		}
	}
	for (const [legacy, role] of Object.entries(slots)) {
		if (!old[legacy] || old[legacy] === "none" || Object.hasOwn(selections, role)) continue;
		selections[role] = { adapter: "claude-cli", command: old.command, model: old[legacy] };
	}
	delete mail.models;
	plan.config.mail = mail;
	plan.writeConfig = true;
	plan.added.push({ key: "models", from: "mail.models" });
}
