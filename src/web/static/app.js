// The decision queue page. No framework: one render per state change, events delegated from #app.
"use strict";

const KINDS = [
	{ kind: "only-you", label: "ONLY YOU CAN ANSWER", filter: "Only you", chip: "ONLY YOU" },
	{ kind: "product", label: "PRODUCT REVIEW", filter: "Product", chip: "PRODUCT REVIEW" },
	{ kind: "ruling", label: "SETS A RULING", filter: "Rulings", chip: "SETS A RULING" },
	{ kind: "idea", label: "IDEAS FROM LEADS", filter: "Ideas", chip: "IDEA" },
];
const DEFAULT_TAG = { "only-you": "Only you", product: "Review", ruling: "Ruling", idea: "Idea" };
const S = {
	route: "queue", items: [], inForce: 0, unconfirmed: 0, testMode: false, filter: "all", sel: 0,
	pick: {}, note: {}, save: {}, wording: {}, editing: {}, busy: false, total: 0, done: 0,
	// Cards waiting in other threads, and the answer in progress on each: its pick, and the server's confirmation once one is asked for.
	cards: [], cpick: {}, carm: {}, cbusy: {},
	rulings: [], rfilter: "all", rsel: 0, rwording: {},
};
const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ago = (iso) => {
	const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
	return m < 60 ? `${m}m` : m < 48 * 60 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const agoLong = (iso) => { const a = ago(iso); return `asked ${a.replace(/m$/, " min").replace(/h$/, " h").replace(/d$/, " days")} ago`; };
const ICON = {
	list: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#7aa2f7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16"></path><path d="M4 12h10"></path><path d="M4 18h6"></path></svg>',
	back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"></path></svg>',
	chev: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"></path></svg>',
	warn: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e0af68" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5"></path><path d="M12 16h.01"></path></svg>',
};

async function api(path, body) {
	const r = await fetch(path, body === undefined ? { headers: { accept: "application/json" } } : { method: "POST", headers: { "content-type": "application/json", "x-decision-queue": "1" }, body: JSON.stringify(body) });
	let j;
	try { j = await r.json(); } catch (e) { throw new Error(r.ok ? `unreadable reply: ${e.message}` : `HTTP ${r.status}`); }
	if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
	return j;
}
let toastTimer;
function toast(msg, err) {
	const t = document.getElementById("toast");
	t.textContent = msg; t.className = err ? "toast err" : "toast"; t.hidden = false;
	clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

// ---- routing ----
function parseRoute() {
	const p = location.pathname;
	if (p === "/rulings") return { route: "rulings" };
	const m = p.match(/^\/item\/(Q-[a-z0-9]+)$/);
	return m ? { route: "item", id: m[1] } : { route: "queue" };
}
function go(path, replace) { (replace ? history.replaceState : history.pushState).call(history, {}, "", path); load(); }
window.addEventListener("popstate", load);

async function load() {
	const r = parseRoute();
	try {
		if (r.route === "rulings") {
			const j = await api("/api/rulings");
			S.rulings = j.rulings; S.route = "rulings";
		} else {
			const j = await api("/api/queue");
			S.health = j.health;
			Object.assign(S, { items: j.items, cards: j.cards || [], inForce: j.inForce, unconfirmed: j.unconfirmed, testMode: j.testMode });
			if (!S.total || S.items.length > S.total - S.done) { S.total = S.items.length + S.done; }
			S.route = r.route;
			if (r.id) { const k = visible().findIndex((i) => i.id === r.id); if (k >= 0) S.sel = k; else if (r.route === "item") { S.route = "queue"; history.replaceState({}, "", "/"); } }
			S.sel = Math.min(S.sel, Math.max(0, visible().length - 1));
		}
	} catch (e) { toast(`Could not load: ${e.message}`, true); }
	render();
}

// ---- queue ----
const visible = () => {
	const f = S.filter === "all" ? S.items : S.items.filter((i) => i.kind === S.filter);
	// Grouped in kind order; the server ranks within each kind.
	return KINDS.flatMap((k) => f.filter((i) => i.kind === k.kind));
};
const current = () => visible()[S.sel];
const defaultPick = (i) => (S.pick[i.id] ?? i.recommended ?? 0);
const shortLabel = (l) => (l.match(/^([A-Z0-9]{1,2})\s*[·:.)-]/)?.[1] ?? (l.length > 22 ? "" : l));
const evidenceCount = (i) => {
	const ev = i.evidence || [];
	const shots = ev.filter((e) => e.type === "image").length, vids = ev.filter((e) => e.type === "video").length;
	return [shots ? `${shots} shot${shots > 1 ? "s" : ""}` : "", vids ? `${vids} demo${vids > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ");
};
const evUrl = (i, e) => `/evidence/${encodeURIComponent(i.id)}/${encodeURIComponent(e.path)}`;

function header() {
	const n = S.items.length;
	const count = (k) => S.items.filter((i) => i.kind === k).length;
	const batch = visible().filter((i) => i.batchable).length;
	const mins = Math.max(1, Math.round(n * 0.7));
	return `<header class="top">
		<div class="brand">${ICON.list}<b>Decisions</b><span class="pill">${n} waiting</span><span class="sub">${n ? `about ${mins} min to clear` : "nothing waiting"}</span>
			<a class="rulings-link" href="/rulings" data-nav="/rulings">Rulings <span class="n">${S.inForce}</span></a></div>
		<nav class="filters" aria-label="Filter">
			<button type="button" data-filter="all" aria-pressed="${S.filter === "all"}">All ${n}</button>
			${KINDS.map((k) => `<button type="button" data-filter="${k.kind}" aria-pressed="${S.filter === k.kind}">${k.filter} ${count(k.kind)}</button>`).join("")}
		</nav>
		<div class="actions">
			<button type="button" class="btn-primary" data-act="accept-all" ${batch ? "" : "disabled"}>Accept ${batch} recommendation${batch === 1 ? "" : "s"} <span class="k">Shift Enter</span></button>
		</div>
	</header>${S.testMode ? '<div class="testbar">TEST MODE: fixture data. No wake is sent and no card is touched.</div>' : ""}`;
}

function listHtml() {
	const v = visible();
	if (!v.length) return `<section class="list" aria-label="Queue"><div class="empty">Nothing waiting on you.<br>New questions from the Steward land here.</div></section>`;
	let n = 0;
	return `<section class="list" aria-label="Queue">${KINDS.map((k) => {
		const rows = v.filter((i) => i.kind === k.kind);
		if (!rows.length) return "";
		return `<div class="group c-${k.kind}"><span class="dot"></span>${k.label}</div>` + rows.map((i) => {
			const idx = n++;
			const tag = i.tag || DEFAULT_TAG[i.kind];
			const img = (i.evidence || []).find((e) => e.type === "image");
			const tagClass = tag.toLowerCase() === "deploy" ? "t-deploy" : tag.toLowerCase() === "secret" || i.secret ? "t-secret" : `c-${i.kind}`;
			return `<a class="row" href="/item/${esc(i.id)}" data-sel="${idx}" aria-current="${idx === S.sel}">
				<span class="num">${idx + 1}</span>
				${img ? `<img class="thumb" alt="" src="${esc(evUrl(i, img))}">` : ""}
				<span class="body"><span class="title">${esc(i.title)}</span>
				<span class="meta"><span class="${tagClass}">${esc(tag)}</span><span>${esc(i.thread)}</span>${evidenceCount(i) ? `<span>${esc(evidenceCount(i))}</span>` : ""}${i.blocks ? `<span>${esc(i.blocks)}</span>` : i.kind === "idea" ? "<span>no deadline</span>" : ""}<span>${ago(i.createdAt)}</span>${i.notNowAt ? '<span class="later">not now</span>' : ""}</span></span>
				<span class="chev">${ICON.chev}</span></a>`;
		}).join("");
	}).join("")}</section>`;
}

function evidenceHtml(i) {
	const ev = i.evidence || [];
	if (!ev.length) return "";
	const vids = ev.filter((e) => e.type === "video"), imgs = ev.filter((e) => e.type === "image"), links = ev.filter((e) => e.type === "link");
	return `<div class="evidence">
		${vids.map((e) => `<figure class="wide"><video controls preload="metadata" src="${esc(evUrl(i, e))}"></video>${e.caption ? `<figcaption>${esc(e.caption)}</figcaption>` : ""}</figure>`).join("")}
		${imgs.map((e) => `<figure><a href="${esc(evUrl(i, e))}" target="_blank" rel="noopener"><img alt="${esc(e.caption || "screenshot")}" src="${esc(evUrl(i, e))}"></a>${e.caption ? `<figcaption>${esc(e.caption)}</figcaption>` : ""}</figure>`).join("")}
		${links.length ? `<div class="links"><span class="lbl">LINKS</span>${links.map((e) => `<a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${esc(e.caption || e.url)}</a>`).join("")}</div>` : ""}
	</div>`;
}

function doesHtml(i) {
	const pick = i.options[defaultPick(i)];
	const settles = `Settles this question only. ${esc(i.thread)} hears “${esc(pick?.label ?? "")}”${S.note[i.id] ? " with your note" : ""}, and nothing else changes.`;
	const wording = S.wording[i.id] ?? i.proposedRuling ?? "";
	const editing = S.editing[i.id] || !i.proposedRuling;
	return `<div class="does"><span class="lbl">WHAT YOUR ANSWER DOES</span><span>${settles}</span>
		<div class="rule">
			<span class="why">${i.proposedRuling ? "I'd also save a standing ruling, so later questions like this don't come to you:" : "No ruling is proposed. You can write one, so later questions like this don't come to you:"}</span>
			${editing ? `<textarea id="wording" rows="2" aria-label="Ruling wording" placeholder="What the ruling decides">${esc(wording)}</textarea>` : `<span class="quote">“${esc(wording)}”</span>`}
			<div class="ctl"><label><input type="checkbox" id="save" ${S.save[i.id] ? "checked" : ""}> Save as a ruling <span class="kbd">S</span></label>
			${i.proposedRuling && !S.editing[i.id] ? '<button type="button" class="linkbtn" data-act="edit-wording">Edit the wording</button>' : ""}
			<span class="safe">Nothing is saved unless you check this.</span></div>
		</div></div>`;
}

// Context with no newline stays one paragraph. Otherwise runs of "- " or "• " lines become one list; other lines are paragraphs.
function contextHtml(text) {
	const s = String(text);
	if (!s.includes("\n")) return `<p class="context">${esc(s)}</p>`;
	let out = "", open = false;
	for (const raw of s.split("\n")) {
		const line = raw.replace(/\r$/, "");
		const b = /^(?:- |• )(.*)$/.exec(line);
		if (b) { out += (open ? "" : "<ul>") + `<li>${esc(b[1])}</li>`; open = true; continue; }
		if (open) { out += "</ul>"; open = false; }
		if (line.trim()) out += `<p>${esc(line)}</p>`;
	}
	return `<div class="context">${out}${open ? "</ul>" : ""}</div>`;
}

function detailHtml() {
	const i = current();
	const v = visible();
	if (!i) return `<section class="detail" aria-label="Selected decision"><div class="empty">Pick a decision on the left.</div></section>`;
	const kind = KINDS.find((k) => k.kind === i.kind);
	const link = i.link ? `<a class="open" href="${esc(i.link)}" target="_blank" rel="noopener">Open thread</a>` : `<span class="open">${esc(i.server)} · ${esc(i.threadId || "")}</span>`;
	const pos = S.done + S.sel + 1, total = S.total || v.length;
	const mtop = `<div class="mtop"><a href="/" data-nav="/" aria-label="Back to decisions">${ICON.back}</a><span class="pos">${S.sel + 1} of ${v.length}</span><div class="bar" aria-hidden="true">${Array.from({ length: Math.min(total, 12) }, (_, k) => `<span class="${k < S.done ? "done" : k === pos - 1 ? "here" : ""}"></span>`).join("")}</div></div>`;
	const head = `<div class="crumbs"><span class="chip ${i.kind}">${kind.chip}</span><span>${esc(i.thread)}</span><span>${agoLong(i.createdAt)}</span>${i.blocks ? `<span>${esc(i.blocks)}</span>` : ""}${link}</div>
		<div class="headline"><h1>${esc(i.title)}</h1>${i.context ? contextHtml(i.context) : ""}</div>`;
	if (i.secret) {
		return `${mtop}<section class="detail" aria-label="Selected decision">${head}
			<div class="secret"><b>This needs a secret.</b><span>Enter it in its own thread. This page never takes a secret value, and the Steward never sees one.</span>
			${i.link ? `<a href="${esc(i.link)}" target="_blank" rel="noopener">Open ${esc(i.thread)} in T3</a>` : `<span>Open “${esc(i.thread)}” on ${esc(i.server)} in T3.</span>`}</div>
			<div class="buttons"><button type="button" class="btn-ghost" data-act="not-now">Not now <span class="kbd">H</span></button></div>
		</section>`;
	}
	const pick = defaultPick(i);
	const opts = i.options.map((o, k) => `<label class="opt ${k === pick ? "on" : ""}"><input type="radio" name="opt" value="${k}" ${k === pick ? "checked" : ""}>
		<span class="txt"><span class="lbl">${esc(o.label)}${k === i.recommended ? '<span class="rec">RECOMMENDED</span>' : ""}</span>${o.detail ? `<span class="det">${esc(o.detail)}</span>` : ""}</span>
		${k < 9 ? `<span class="kbd">${k + 1}</span>` : ""}</label>`).join("");
	const sl = shortLabel(i.options[pick]?.label ?? "");
	return `${mtop}<section class="detail" aria-label="Selected decision">${head}${evidenceHtml(i)}
		<fieldset class="answer"><legend class="legend">YOUR ANSWER</legend>${opts}</fieldset>
		<div class="note"><label for="note">Note to the thread (optional) <span class="kbd">R</span></label><textarea id="note" rows="2" placeholder="Anything the thread should know with your answer.">${esc(S.note[i.id] || "")}</textarea></div>
		${doesHtml(i)}
		<div class="buttons"><button type="button" class="btn-answer" data-act="answer" ${S.busy ? "disabled" : ""}>Answer${sl ? ` ${esc(sl)}` : ""} <span class="kbd">Enter</span></button>
			<button type="button" class="btn-ghost" data-act="not-now">Not now <span class="kbd">H</span></button></div>
	</section>
	<footer class="mbar i-mbar"><button type="button" class="btn-ghost" data-act="not-now">Not now</button><button type="button" class="btn-answer" data-act="answer" ${S.busy ? "disabled" : ""}>Answer${sl ? ` ${esc(sl)}` : ""}</button></footer>`;
}

function renderQueue() {
	const batch = visible().filter((i) => i.batchable).length;
	app.className = `app ${S.route === "item" ? "on-item" : ""}`;
	app.innerHTML = `${header()}<details><summary>${esc(S.health ? `Steward: ${S.health.verdict} · ${S.health.at}${Date.now() - Date.parse(S.health.at) > 2 * 3600_000 ? " · stale" : ""}` : "Steward health: awaiting first measurement")}</summary><pre>${esc(S.health?.report ?? "")}</pre></details><main class="main">${listHtml()}${detailHtml()}</main>${cardsHtml()}
		<footer class="hints"><span><span class="kbd">J</span> <span class="kbd">K</span> move</span><span><span class="kbd">1</span>–<span class="kbd">9</span> choose</span><span><span class="kbd">Enter</span> answer</span><span><span class="kbd">H</span> not now</span><span><span class="kbd">R</span> note</span><span><span class="kbd">S</span> save as ruling</span><span><span class="kbd">Shift</span> <span class="kbd">Enter</span> accept every recommendation</span><span class="right">Only-you items and secrets never batch</span></footer>
		<footer class="mbar q-mbar"><button type="button" class="btn-primary" data-act="accept-all" ${batch ? "" : "disabled"}>Accept ${batch} recommendation${batch === 1 ? "" : "s"}</button></footer>`;
}

async function answerCurrent() {
	const i = current();
	if (!i || i.secret || S.busy) return;
	S.busy = true; render();
	try {
		const body = { choice: defaultPick(i), note: S.note[i.id] || undefined, saveRuling: Boolean(S.save[i.id]) };
		if (S.save[i.id]) body.rulingWording = S.wording[i.id] ?? i.proposedRuling;
		const r = await api(`/api/items/${encodeURIComponent(i.id)}/answer`, body);
		S.done++;
		toast(`Answered “${i.title}”${r.ruling ? `, and saved ruling ${r.ruling}` : ""}. ${r.to === "thread" ? "It goes straight to its thread." : "Recorded; the wake to the Steward is queued."}`);
		const onItem = S.route === "item";
		S.busy = false;
		await load();
		const next = current();
		if (onItem) go(next ? `/item/${next.id}` : "/", true);
	} catch (e) { S.busy = false; toast(e.message, true); render(); }
}
async function notNow() {
	const i = current();
	if (!i) return;
	try { await api(`/api/items/${encodeURIComponent(i.id)}/not-now`, {}); toast("Moved to the end of the queue."); await load(); } catch (e) { toast(e.message, true); }
}
async function acceptAll() {
	const ids = visible().filter((i) => i.batchable).map((i) => i.id);
	if (!ids.length) return;
	if (!confirm(`Accept the recommended option on ${ids.length} decision${ids.length === 1 ? "" : "s"}? Only-you items and secrets are left for you, and no ruling is saved.`)) return;
	try {
		const r = await api("/api/accept-all", { ids });
		S.done += r.answered.length;
		toast(`Accepted ${r.answered.length}.${r.skipped.length ? ` Left ${r.skipped.length} for you.` : ""}`);
		await load();
	} catch (e) { toast(e.message, true); }
}

// ---- cards waiting in other threads ----
// A question card is answered with one tap. An approval or a goal proposal takes two, and the second is the SERVER's: the first asks it for a
// single-use confirmation bound to this card as shown, this choice and this browser session; the second presents it. The page cannot skip
// the step (a request without it is refused), and it only shows what the server has already decided.
const CARD_KIND = { question: "QUESTION CARD", approval: "APPROVAL", goal: "GOAL PROPOSAL", secret: "SECRET · IN ITS THREAD", link: "LINK · IN ITS THREAD" };
const confirmable = (c) => c.type === "approval" || c.type === "goal";
const cardPick = (c) => S.cpick[c.id] ?? (Number.isInteger(c.recommended) ? c.recommended : -1);
const armedFor = (c) => { const a = S.carm[c.id]; return a && a.choice === cardPick(c) && a.sig === c.sig && a.expiresAt > Date.now() ? a : undefined; };
function cardHtml(c) {
	const head = `<div class="crumbs"><span class="chip ${esc(c.type)}">${esc(CARD_KIND[c.type] || c.type)}</span><span>${esc(c.threadTitle)}</span><span>${esc(c.server)}</span>${c.link ? `<a class="open" href="${esc(c.link)}" target="_blank" rel="noopener">Open thread</a>` : ""}</div>
		<div class="headline"><h1>${esc(c.header || "Question")}</h1>${c.question ? contextHtml(c.question) : ""}</div>${c.command ? `<pre class="cmd">${esc(c.command)}</pre>` : ""}`;
	if (!c.answerable) return `<article class="ccard" data-card="${esc(c.id)}">${head}<div class="secret"><span>${esc(c.why || "Answer it in its thread.")}</span></div></article>`;
	const pick = cardPick(c), armed = armedFor(c);
	const opts = c.options.map((o, k) => `<label class="opt ${k === pick ? "on" : ""}"><input type="radio" name="copt-${esc(c.id)}" data-cid="${esc(c.id)}" value="${k}" ${k === pick ? "checked" : ""}><span class="txt"><span class="lbl">${esc(o.label)}${k === c.recommended ? '<span class="rec">RECOMMENDED</span>' : ""}</span>${o.detail ? `<span class="det">${esc(o.detail)}</span>` : ""}</span></label>`).join("");
	const label = pick < 0 ? "Pick an option" : armed ? `Tap again to confirm: ${esc(c.options[pick].label)}` : confirmable(c) ? esc(c.options[pick].label) : `Answer ${esc(c.options[pick].label)}`;
	return `<article class="ccard" data-card="${esc(c.id)}">${head}<fieldset class="answer"><legend class="legend">YOUR ANSWER</legend>${opts}</fieldset>
		<div class="buttons"><button type="button" class="btn-answer" data-cact="answer" data-cid="${esc(c.id)}" ${pick < 0 || S.cbusy[c.id] ? "disabled" : ""}>${label}</button></div>
		${armed ? '<div class="from">This is an approval: it needs this second tap, which expires in a minute. Changing the option cancels it.</div>' : ""}</article>`;
}
function cardsHtml() {
	if (!S.cards.length) return "";
	return `<section class="cards" aria-label="Waiting in threads"><div class="group"><span class="dot"></span>WAITING IN THREADS · ${S.cards.length}<button type="button" class="linkbtn" data-cact="refresh">Refresh</button></div>${S.cards.map(cardHtml).join("")}</section>`;
}
async function cardAct(act, id) {
	if (act === "refresh") { await load(); return; }
	const c = S.cards.find((x) => x.id === id), choice = c ? cardPick(c) : -1;
	if (!c || !c.answerable || choice < 0 || S.cbusy[id]) return;
	const armed = armedFor(c);
	S.cbusy[id] = true; render();
	try {
		if (confirmable(c) && !armed) {
			const r = await api(`/api/cards/${encodeURIComponent(id)}/confirm`, { choice, sig: c.sig });
			S.carm[id] = { challenge: r.challenge, choice, sig: c.sig, expiresAt: r.expiresAt };
			toast(`Tap again within ${Math.round(r.expiresInMs / 1000)} seconds to confirm: ${r.decision}.`);
			setTimeout(() => { if (S.carm[id] && S.carm[id].expiresAt <= Date.now() + 100) { delete S.carm[id]; render(); } }, r.expiresInMs + 200);
		} else {
			const r = await api(`/api/cards/${encodeURIComponent(id)}/answer`, { choice, sig: c.sig, ...(confirmable(c) ? { challenge: armed.challenge } : {}) });
			delete S.carm[id];
			S.cards = S.cards.filter((x) => x.id !== id);
			toast(`${r.choice || "Answered"}. It goes to its thread.`);
		}
	} catch (e) { delete S.carm[id]; toast(e.message, true); } finally { delete S.cbusy[id]; render(); }
}

// ---- rulings ----
const RFILTERS = [
	["all", "All"], ["unconfirmed", "Unconfirmed"], ["proposed", "Proposed"], ["chat", "From chat"], ["card", "From a card"], ["retired", "Retired"],
];
const rvisible = () => {
	const f = S.rfilter;
	const live = S.rulings.filter((r) => r.status !== "retired");
	const list = f === "all" ? live : f === "unconfirmed" ? live.filter((r) => !r.confirmed) : f === "proposed" ? live.filter((r) => r.status === "proposed")
		: f === "chat" ? live.filter((r) => r.source === "chat") : f === "card" ? live.filter((r) => r.source === "card") : S.rulings.filter((r) => r.status === "retired");
	// Unconfirmed first, then newest.
	return [...list].sort((a, b) => Number(a.confirmed) - Number(b.confirmed) || b.date.localeCompare(a.date) || Number(b.id.slice(1)) - Number(a.id.slice(1)));
};
const rretired = (r) => r.retiredHow === "only this once" ? "only this once" : r.retiredHow === "superseded" ? `superseded${r.supersededBy ? ` by ${r.supersededBy}` : ""}` : r.retiredHow === "duplicate" ? `duplicate${r.supersededBy ? ` of ${r.supersededBy}` : ""}` : r.retiredHow === "expired" || r.retiredHow === "repeat" ? r.retiredHow : "retired";
const rbound = (r) => `${r.expires ? `expires ${r.expires}` : ""}${r.expires && r.until ? ", " : ""}${r.until ? `until ${r.until}` : ""}`;
const rstate = (r) => r.status === "retired" ? `<div class="state off">${esc(rretired(r))}</div>`
	: r.expired ? `<div class="state warn">expired ${esc(r.expires)}</div>`
	: r.status === "proposed" ? '<div class="state warn">proposed, not in force</div>' : r.confirmed ? '<div class="state">confirmed</div>' : '<div class="state warn">unconfirmed</div>';

function renderRulings() {
	const live = S.rulings.filter((r) => r.status !== "retired");
	const inForce = S.rulings.filter((r) => r.status === "in-force" && !r.expired).length;
	const unconf = live.filter((r) => !r.confirmed).length;
	const v = rvisible();
	S.rsel = Math.min(S.rsel, Math.max(0, v.length - 1));
	const sel = v[S.rsel];
	app.className = "app";
	const rows = v.map((r, k) => `<tr class="r" data-rsel="${k}" aria-current="${k === S.rsel}">
		<td><span class="rid">${esc(r.id)}</span>“${esc(r.words)}”<div class="date">${esc(r.date)}${rbound(r) ? ` · ${esc(rbound(r))}` : ""}</div></td>
		<td class="dec">${esc(r.decides)}</td>
		<td><span class="${r.source === "chat" ? "src-chat" : "src-card"}">${r.source === "chat" ? "Chat" : "Card answer"}</span>${rstate(r)}</td>
		<td class="n mono ${r.cited ? "" : "zero"}">${r.cited || "–"}</td></tr>`).join("");
	app.innerHTML = `<header class="top">
		<a class="back" href="/" data-nav="/">${ICON.back.replace('width="22" height="22"', 'width="16" height="16"')}Decisions</a>
		<h2>Standing rulings</h2><span class="sub r">${inForce} in force. Each one answers questions so they never reach you.</span>
		<nav class="filters right" aria-label="Filter">${RFILTERS.map(([k, l]) => `<button type="button" data-rfilter="${k}" aria-pressed="${S.rfilter === k}" class="${k === "unconfirmed" ? "warn" : ""}">${l}</button>`).join("")}</nav>
	</header>
	${unconf ? `<div class="banner">${ICON.warn}<span>${unconf} of these began as answers on question cards that I saved as rulings myself, or are proposals. Confirm, edit or retire each one. From now on, a ruling is in force only when you confirm it.</span><button type="button" class="btn-yellow" data-act="review-unconfirmed">Review them one by one</button></div>` : ""}
	<main class="rmain">
		<section class="rtable" aria-label="Rulings"><table><thead><tr><th scope="col">Your words</th><th scope="col">What it decides</th><th scope="col">From</th><th scope="col" class="n">Cited</th></tr></thead>
		<tbody>${rows || '<tr><td colspan="4" class="empty">No rulings here.</td></tr>'}</tbody></table>
		<div class="foot">Showing ${v.length} of ${S.rulings.length}. Cited counts decisions that named the ruling by its ID; a dash means none has yet.</div></section>
		${sel ? rasideHtml(sel) : ""}
	</main>`;
}

function rasideHtml(r) {
	const label = r.status === "retired" ? ["RETIRED", "off"] : r.expired ? ["EXPIRED, NOT IN FORCE", "warn"] : r.status === "proposed" ? ["PROPOSED, NOT IN FORCE", "warn"] : r.confirmed ? ["IN FORCE", "ok"] : ["UNCONFIRMED", "warn"];
	const from = r.source === "chat" ? `Your words in chat, ${esc(r.date)}` : `Your answer on a question card, ${esc(r.date)}`;
	const wording = S.rwording[r.id] ?? r.decides;
	const cites = r.recent?.length ? r.recent.map((c) => `<span>${esc(c.decision)}</span>`).join("") : '<span class="zero">Not cited by ID yet.</span>';
	const btns = r.status === "retired" ? "" : `<div class="btns">
		${r.expired ? "" : !r.confirmed || r.status === "proposed" ? '<button type="button" class="btn-green" data-ract="confirm">Confirm <span class="kbd">Enter</span></button>' : '<button type="button" class="btn-sm" data-ract="edit">Save wording <span class="kbd">Enter</span></button>'}
		<button type="button" class="btn-sm" data-ract="once">Only this once <span class="kbd">O</span></button>
		<button type="button" class="btn-sm btn-red" data-ract="retire">Retire <span class="kbd">X</span></button></div>`;
	return `<aside class="raside" aria-label="Selected ruling"><span class="status s-${label[1]}">${label[0]} · ${esc(r.id)}</span>
		<div class="stack"><span class="from">${from}</span><span class="words">“${esc(r.words)}”</span></div>
		<div class="stack"><label for="rw" class="from">${r.status === "retired" ? "What it decided" : "Wording I saved (edit before you confirm)"}</label>
		<textarea id="rw" rows="4" ${r.status === "retired" ? "readonly" : ""}>${esc(wording)}</textarea></div>
		${r.status === "retired" && (r.retiredWhy || r.supersededBy) ? `<div class="stack"><span class="from">Why it left force: ${esc(rretired(r))}</span><span class="words">${esc(r.retiredWhy || "")}</span></div>` : ""}${rbound(r) ? `<div class="stack"><span class="from">Time-bound: ${esc(rbound(r))}</span></div>` : ""}
		<div class="cites"><span class="lbl">Last cited${r.cited ? ` (${r.cited})` : ""}</span>${cites}</div>${btns}</aside>`;
}

async function rulingAct(action) {
	const r = rvisible()[S.rsel];
	if (!r || r.status === "retired") return;
	if (action === "retire" && !confirm(`Retire ${r.id}? It stops being a standing ruling.`)) return;
	try {
		await api(`/api/rulings/${encodeURIComponent(r.id)}/${action}`, { decides: S.rwording[r.id] ?? r.decides });
		delete S.rwording[r.id];
		toast({ confirm: `${r.id} confirmed and in force.`, edit: `${r.id} wording saved.`, once: `${r.id} settled its one case and is no longer a ruling.`, retire: `${r.id} retired.` }[action]);
		await load();
	} catch (e) { toast(e.message, true); }
}

function render() { if (S.route === "rulings") renderRulings(); else renderQueue(); }

// ---- events ----
app.addEventListener("click", (ev) => {
	const t = ev.target.closest("[data-nav],[data-sel],[data-filter],[data-act],[data-rfilter],[data-rsel],[data-ract],[data-cact]");
	if (!t) return;
	if (t.dataset.nav) { ev.preventDefault(); go(t.dataset.nav); return; }
	if (t.dataset.sel !== undefined) {
		ev.preventDefault();
		S.sel = Number(t.dataset.sel);
		const i = current();
		if (matchMedia("(max-width: 760px)").matches) go(`/item/${i.id}`); else { history.replaceState({}, "", "/"); render(); }
		return;
	}
	if (t.dataset.filter) { S.filter = t.dataset.filter; S.sel = 0; render(); return; }
	if (t.dataset.rfilter) { S.rfilter = t.dataset.rfilter; S.rsel = 0; render(); return; }
	if (t.dataset.rsel !== undefined) { S.rsel = Number(t.dataset.rsel); render(); if (matchMedia("(max-width: 760px)").matches) document.querySelector(".raside")?.scrollIntoView({ behavior: "smooth" }); return; }
	if (t.dataset.ract) { rulingAct(t.dataset.ract); return; }
	if (t.dataset.cact) { cardAct(t.dataset.cact, t.dataset.cid); return; }
	const a = t.dataset.act;
	if (a === "answer") answerCurrent();
	else if (a === "not-now") notNow();
	else if (a === "accept-all") acceptAll();
	else if (a === "edit-wording") { const i = current(); S.editing[i.id] = true; render(); document.getElementById("wording")?.focus(); }
	else if (a === "review-unconfirmed") { S.rfilter = "unconfirmed"; S.rsel = 0; render(); document.getElementById("rw")?.focus(); }
});
app.addEventListener("change", (ev) => {
	// Changing the pick on a card cancels any confirmation asked for: it was for the choice that was shown.
	if (ev.target.dataset?.cid && ev.target.name?.startsWith("copt-")) { S.cpick[ev.target.dataset.cid] = Number(ev.target.value); delete S.carm[ev.target.dataset.cid]; render(); return; }
	const i = current();
	if (ev.target.name === "opt" && i) { S.pick[i.id] = Number(ev.target.value); render(); }
	if (ev.target.id === "save" && i) { S.save[i.id] = ev.target.checked; }
});
app.addEventListener("input", (ev) => {
	const i = current();
	if (ev.target.id === "note" && i) S.note[i.id] = ev.target.value;
	if (ev.target.id === "wording" && i) S.wording[i.id] = ev.target.value;
	if (ev.target.id === "rw") { const r = rvisible()[S.rsel]; if (r) S.rwording[r.id] = ev.target.value; }
});

document.addEventListener("keydown", (ev) => {
	const el = document.activeElement;
	const typing = el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && el.type !== "radio" && el.type !== "checkbox"));
	if (ev.key === "Escape" && typing) { el.blur(); return; }
	if (ev.metaKey || ev.ctrlKey || ev.altKey) {
		if (typing && ev.key === "Enter" && S.route !== "rulings") { ev.preventDefault(); answerCurrent(); }
		return;
	}
	if (typing) return;
	const k = ev.key;
	if (S.route === "rulings") {
		const n = rvisible().length;
		if (k === "j" || k === "J") { S.rsel = Math.min(n - 1, S.rsel + 1); render(); }
		else if (k === "k" || k === "K") { S.rsel = Math.max(0, S.rsel - 1); render(); }
		else if (k === "Enter") { const r = rvisible()[S.rsel]; if (r) rulingAct(!r.confirmed || r.status === "proposed" ? "confirm" : "edit"); }
		else if (k === "o" || k === "O") rulingAct("once");
		else if (k === "x" || k === "X") rulingAct("retire");
		else if (k === "e" || k === "E") { ev.preventDefault(); document.getElementById("rw")?.focus(); }
		else return;
		ev.preventDefault();
		return;
	}
	const i = current();
	const n = visible().length;
	if (k === "Enter" && ev.shiftKey) acceptAll();
	else if (k === "j" || k === "J") { S.sel = Math.min(n - 1, S.sel + 1); render(); }
	else if (k === "k" || k === "K") { S.sel = Math.max(0, S.sel - 1); render(); }
	else if (/^[1-9]$/.test(k) && i && !i.secret) { const c = Number(k) - 1; if (c < i.options.length) { S.pick[i.id] = c; render(); } }
	else if (k === "Enter") answerCurrent();
	else if (k === "h" || k === "H") notNow();
	else if (k === "r" || k === "R") document.getElementById("note")?.focus();
	else if ((k === "s" || k === "S") && i && !i.secret) { S.save[i.id] = !S.save[i.id]; render(); }
	else return;
	ev.preventDefault();
});

load();
