// The decision queue for T3's inline chat frames. The Steward renders only a two-line shell that loads this file, so
// showing the queue costs it almost nothing; questions come live from /api/queue. Theme comes from T3's CSS variables.
// An inline frame has little authority, and the SERVER enforces it (inlineVerdict in app.ts): it may GET /api/queue, /api/recent and
// /api/rulings, and POST a plain question answer (a choice and a note). It never answers a card or an approval, never saves a ruling,
// and never reads one item on its own. This file does not try: those are done on the full queue page.
(() => {
	const SRC = new URL(document.currentScript.src);
	// A phone lays out a page with no viewport tag at desktop width and shrinks it to fit, so the view reads tiny.
	// Shells posted before the tag was added to them get it here.
	try { if (document.head && !document.querySelector('meta[name="viewport"]')) { const m = document.createElement("meta"); m.name = "viewport"; m.content = "width=device-width, initial-scale=1"; document.head.append(m); } } catch { /* a page without a head keeps its layout */ }
	const BASE = SRC.origin;
	// The view key (never the page key: a Decisions post is copied into the thread) rides on this script's own address (?k=). Every call proves it with a header; the image links below carry it as ?k= too, but the page serves evidence only to its own link or cookie.
	// A 401 means the key is missing, or it was rotated since this view was made: say so instead of showing an empty queue.
	const KEY = SRC.searchParams.get("k") || "";
	const kq = KEY ? `?k=${encodeURIComponent(KEY)}` : "";
	const authFetch = async (url, init = {}) => {
		const r = await fetch(url, { ...init, headers: { ...(init.headers || {}), ...(KEY ? { "x-decision-token": KEY } : {}) } });
		if (r.status === 401) showLocked();
		if (r.status === 401) throw new Error("this view's key no longer works (it was rotated, or its link is old). Ask for a fresh view: run `chamberlain web link`, then send the Decisions setup message again");
		return r;
	};
	// A banner that stays whatever else is on screen: a 401 can come on a refresh, with cards showing, and a "?" count alone would say nothing.
	let lockedShown = false;
	function showLocked() {
		if (lockedShown) return;
		lockedShown = true;
		wrap.insertBefore(el("div", "dq-msg dq-bad dq-locked", "This view's key no longer works (it was rotated, or its link is old). Run `chamberlain web link` and send the Decisions setup message again to bring it back."), wrap.firstChild);
	}
	// ?item=Q-… shows that one question (a Questions-thread card); without it, the whole open queue.
	const ITEM = /^Q-[a-z0-9]{4,16}$/.test(SRC.searchParams.get("item") ?? "") ? SRC.searchParams.get("item") : null;
	// ?view=decisions is the pinned Decisions thread: Waiting, Rulings and Recent tabs that keep themselves current.
	const DASH = SRC.searchParams.get("view") === "decisions";
	const KIND = { "only-you": "ONLY YOU", product: "PRODUCT REVIEW", ruling: "SETS A RULING", idea: "IDEA", thread: "FROM A THREAD", approval: "APPROVAL", goal: "GOAL PROPOSAL", secret: "SECRET · IN ITS THREAD", link: "LINK · IN ITS THREAD" };
	// A card waiting in another thread, shaped like a queue item. It is shown here and answered on the full page.
	const fromCard = (c) => ({ id: c.id, kind: c.type === "question" ? "thread" : c.type, title: c.header || "Question", context: c.question, options: c.options, recommended: c.recommended, mirrored: c });
	const css = `*{box-sizing:border-box}body{font-family:var(--font-sans);margin:0}
.dq{display:flex;flex-direction:column;gap:12px}.dq-head{display:flex;align-items:center;gap:8px;font-weight:700;font-size:16px}
.dq-count{font-family:var(--font-mono);font-size:12px;padding:2px 8px;border-radius:999px;background:var(--secondary);color:var(--secondary-foreground);font-weight:500}
.dq-reload{margin-left:auto;font:inherit;font-size:13px;font-weight:500;background:none;border:1px solid var(--border);color:var(--foreground);border-radius:var(--radius);padding:8px 12px;min-height:40px}
.dq-card{background:var(--card);border:1px solid var(--border);border-radius:var(--radius);padding:16px;display:flex;flex-direction:column;gap:10px}
.dq-kind{font-family:var(--font-mono);font-size:11px;letter-spacing:.06em;color:var(--muted-foreground)}
.dq-kind.only-you{color:var(--destructive)}.dq-kind.product{color:var(--chart-4)}.dq-kind.ruling{color:var(--warning)}.dq-kind.idea{color:var(--success)}.dq-kind.thread{color:var(--info)}.dq-kind.approval,.dq-kind.secret,.dq-kind.link{color:var(--warning)}.dq-kind.goal{color:var(--primary)}
.dq-cmd{font-family:var(--font-mono);font-size:12px;white-space:pre-wrap;word-break:break-all;background:var(--code-background,var(--muted));border:1px solid var(--border);border-radius:var(--radius);padding:10px;margin:0;max-height:240px;overflow:auto}
.dq-title{font-weight:600;font-size:15px;line-height:1.3}.dq-ctx{font-size:13px;color:var(--muted-foreground);line-height:1.45}.dq-ctx p{margin:0}.dq-ctx>*+*{margin-top:6px}.dq-ctx ul{margin:0;padding-left:18px}.dq-ctx li+li{margin-top:4px}
.dq-ev{display:flex;gap:8px;overflow-x:auto}.dq-ev img{height:140px;border-radius:var(--radius);border:1px solid var(--border)}
.dq-opt{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--border);border-radius:var(--radius);min-height:48px;cursor:pointer}
.dq-opt.sel{border-color:var(--primary);background:color-mix(in srgb,var(--primary) 12%,transparent)}
.dq-opt input{margin-top:3px;accent-color:var(--primary);width:18px;height:18px}
.dq-l{font-weight:600;font-size:14px}.dq-d{font-size:12px;color:var(--muted-foreground)}.dq-rec{font-family:var(--font-mono);font-size:10px;color:var(--primary);margin-left:6px}
.dq textarea{width:100%;font:inherit;font-size:14px;background:var(--background);color:var(--foreground);border:1px solid var(--border);border-radius:var(--radius);padding:10px;resize:vertical;min-height:44px}
.dq-go{font:inherit;font-weight:600;font-size:15px;border:0;border-radius:var(--radius);padding:12px 16px;min-height:48px;background:var(--primary);color:var(--primary-foreground)}
.dq-tabs{display:flex;gap:6px}.dq-tab{font:inherit;font-size:13px;font-weight:600;background:none;border:1px solid var(--border);color:var(--muted-foreground);border-radius:999px;padding:8px 14px;min-height:40px}
.dq-tab.on{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground)}.dq-focus{outline:2px solid var(--primary);outline-offset:2px}
.dq-row{border-bottom:1px solid var(--border);padding:10px 0;display:flex;flex-direction:column;gap:4px}.dq-row:last-child{border-bottom:0}
.dq-meta{font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground)}
.dq-link{display:inline-flex;align-items:center;align-self:flex-start;min-height:40px;padding:0 2px;font-size:13px;color:var(--primary);text-decoration:underline;text-underline-offset:3px}
.dq-go:disabled{opacity:.5}.dq-msg{font-size:13px}.dq-expired{color:var(--warning);font-weight:600}.dq-ok{color:var(--success)}.dq-bad{color:var(--destructive)}.dq-empty{color:var(--muted-foreground);font-size:14px;padding:12px 0}.dq-away{color:var(--muted-foreground)}`;
	const healthCss = `.dq-health{padding:0;border:1px solid var(--border);border-radius:10px;background:var(--card);font-size:13px;--health-tone:var(--success)}
.dq-health-summary{list-style:none;cursor:pointer;padding:10px 12px;display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;align-items:center;gap:6px 10px}.dq-health-summary::-webkit-details-marker{display:none}.dq-health-summary:focus-visible{outline:2px solid var(--primary);outline-offset:2px;border-radius:10px}.dq-health-chevron{font-size:14px;color:var(--muted-foreground);transition:transform .15s}.dq-health[open]>.dq-health-summary .dq-health-chevron{transform:rotate(90deg)}.dq-health[open]>.dq-health-summary{border-bottom:1px solid var(--border)}
.dq-health-mini{display:flex;align-items:center;justify-content:flex-end;gap:8px;font-family:var(--font-mono);font-size:11px;white-space:nowrap}.dq-health-mini-track{width:54px;height:4px;background:var(--muted);border-radius:9px;overflow:hidden}.dq-health-mini-fill{height:100%;background:var(--health-tone)}.dq-health-brief{grid-column:1/-1;display:flex;align-items:center;gap:4px 12px;flex-wrap:wrap;font-size:11px;color:var(--muted-foreground)}.dq-health-brief .dq-health-age{margin-left:auto}.dq-health>:not(summary){margin-left:12px;margin-right:12px}.dq-health>.dq-health-evidence{margin-bottom:10px}@media(max-width:380px){.dq-health-mini-track{display:none}.dq-health-summary{gap:6px}.dq-health-brief{gap:4px 8px}}
.dq-health-top,.dq-health-context{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.dq-health-name{font-weight:600;font-size:14px}.dq-health-age{font-size:11px;color:var(--muted-foreground)}
.dq-health-badge{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;font-size:11px;font-weight:700;color:var(--health-tone);background:color-mix(in srgb,var(--health-tone) 12%,transparent)}
.dq-health-dot{width:6px;height:6px;border-radius:50%;background:currentColor}.dq-health-context{margin-top:16px;color:var(--muted-foreground);font-size:12px}.dq-health-value{color:var(--foreground);font-family:var(--font-mono);font-size:13px}
.dq-health-track{height:7px;background:var(--muted);border-radius:99px;margin:8px 0;position:relative;overflow:hidden}.dq-health-fill{height:100%;background:var(--health-tone);border-radius:99px}.dq-health-mark{position:absolute;top:0;height:100%;border-left:2px solid var(--foreground);opacity:.6}
.dq-health-scale{display:flex;justify-content:space-between;color:var(--muted-foreground);font-size:10px;gap:12px}.dq-health-signals{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:16px}.dq-health-signal{background:var(--muted);border-radius:8px;padding:10px;min-width:0}.dq-health-signal strong{display:block;font-family:var(--font-mono);font-size:16px;color:var(--foreground);margin:4px 0}.dq-health-label{font-size:11px;color:var(--muted-foreground)}.dq-health-note{font-size:10px;color:var(--muted-foreground);line-height:1.4}.dq-health-evidence{margin-top:12px;font-size:11px;color:var(--muted-foreground)}.dq-health-evidence summary{cursor:pointer;padding:4px 0}.dq-health-evidence pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.6}.dq-health-warning{margin-top:10px;color:var(--warning);font-size:12px}`;
	const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
	function paintHealth(root, h, limits) {
		const expanded = root.querySelector(".dq-health-evidence")?.open;
		root.style.setProperty("--health-tone", !h || h.unknown?.length || h.verdict === "WATCH" || h.verdict === "COMPACT" ? "var(--warning)" : h.verdict === "HAND OFF" ? "var(--destructive)" : "var(--success)");
		const minutes = h ? Math.max(0, Math.floor((Date.now() - Date.parse(h.at)) / 60000)) : NaN;
		const stale = !Number.isFinite(minutes) || minutes > 120;
		const top = el("summary", "dq-health-summary");
		const name = el("span", "dq-health-name", "Steward");
		const badge = el("span", "dq-health-badge", !h ? "AWAITING DATA" : stale ? "STALE" : h.unknown?.length ? "LIMITED DATA" : h.verdict);
		badge.append(el("span", "dq-health-dot"));
		const age = el("div", "dq-health-age", !h ? "First check pending" : !Number.isFinite(minutes) ? "Check time unavailable" : minutes < 1 ? "Checked just now" : `Checked ${minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`} ago`);
		age.setAttribute("title", h?.at ?? "");
		const short = (v) => Number.isFinite(v) ? `${Math.round(v / 1000)}k` : "—";
		const mini = el("span", "dq-health-mini", h && Number.isFinite(h.tokens) ? `${short(h.tokens)}${limits?.compactContext ? ` / ${short(limits.compactContext)}` : " tokens"}` : "—");
		mini.setAttribute("title", "Context tokens / compaction threshold");
		if (Number.isFinite(h?.tokens) && limits?.compactContext > 0) {
			const track = el("span", "dq-health-mini-track"), fill = el("span", "dq-health-mini-fill");
			track.setAttribute("aria-hidden", "true"); fill.style.display = "block"; fill.style.width = `${Math.max(0, Math.min(100, h.tokens / limits.compactContext * 100))}%`; track.append(fill); mini.append(track);
		}
		const brief = el("span", "dq-health-brief");
		if (h) { brief.append(el("span", "", `Slips ${h.replies ? `${h.breaks}/${h.replies}` : "—"}`), el("span", "", `Reads ${h.tokens == null ? "—" : `${h.selfReads} self · ${h.threadRereads} repeat`}`)); }
		brief.append(age);
		top.append(name, badge, mini, el("span", "dq-health-chevron", "›"), brief); root.replaceChildren(top);
		if (!h) return;
		if (stale) { root.style.setProperty?.("--health-tone", "var(--warning)"); root.append(el("div", "dq-health-warning", `Last known status: ${h.verdict}. Waiting for a fresh check.`)); }
		const known = Number.isFinite(h.tokens), hard = limits?.compactContext;
		const context = el("div", "dq-health-context", "Context used");
		context.append(el("span", "dq-health-value", known ? `${short(h.tokens)}${hard ? ` / ${short(hard)}` : " tokens"}` : "Unavailable")); root.append(context);
		if (known && hard > 0) {
			const track = el("div", "dq-health-track");
			track.setAttribute("role", "meter"); track.setAttribute("aria-label", "Context tokens"); track.setAttribute("aria-valuemin", "0"); track.setAttribute("aria-valuemax", String(hard)); track.setAttribute("aria-valuenow", String(Math.min(hard, h.tokens))); track.setAttribute("aria-valuetext", `${h.tokens.toLocaleString()} tokens; compact at ${hard.toLocaleString()}`);
			const fill = el("div", "dq-health-fill"); fill.style.width = `${Math.max(0, Math.min(100, h.tokens / hard * 100))}%`; track.append(fill);
			if (limits.context > 0) { const mark = el("span", "dq-health-mark"); mark.style.left = `${Math.min(100, limits.context / hard * 100)}%`; track.append(mark); }
			root.append(track);
			const scale = el("div", "dq-health-scale", `${short(limits.context)} watch threshold`); scale.append(el("span", "", `${short(hard)} compact at`)); root.append(scale);
		}
		const signals = el("div", "dq-health-signals");
		for (const [label, value, note, elevated] of [
			["Format slips", h.replies ? `${h.breaks} / ${h.replies}` : "—", h.replies ? "recent replies" : "No reply samples", h.elevated?.includes("format")],
			["Self reads", h.tokens == null ? "—" : h.selfReads, "since compaction", limits && h.selfReads >= limits.selfReads],
			["Repeat reads", h.tokens == null ? "—" : h.threadRereads, "since compaction", limits && h.threadRereads >= limits.threadRereads],
		]) { const tile = el("div", "dq-health-signal"); tile.append(el("span", "dq-health-label", label), el("strong", "", value), el("span", "dq-health-note", elevated ? "↑ Above threshold" : note)); signals.append(tile); }
		root.append(signals);
		if (h.unknown?.length) root.append(el("div", "dq-health-warning", "Some measurements are unavailable."));
		const details = el("details", "dq-health-evidence"); details.open = Boolean(expanded); details.append(el("summary", "", "Measurement details"), el("pre", "", h.report)); root.append(details);
	}
	const style = el("style"); style.textContent = css + healthCss; document.head.append(style);
	const root = document.getElementById("dq") || document.body.appendChild(el("div"));
	const wrap = el("div", "dq");
	const head = el("div", "dq-head", "Decisions ");
	const count = el("span", "dq-count", "…");
	const reload = el("button", "dq-reload", "Refresh"); reload.type = "button";
	const list = el("div");
	head.append(count, reload); wrap.append(head, list); root.replaceChildren(wrap);

	async function load() {
		list.replaceChildren(el("div", "dq-empty", "Loading the queue…"));
		if (ITEM) return loadOne();
		try {
			const q = await (await authFetch(`${BASE}/api/queue`, { cache: "no-store" })).json();
			const items = q.items || [];
			count.textContent = `${items.length} waiting`;
			if (!items.length) { list.replaceChildren(el("div", "dq-empty", "Nothing waiting. The queue is clear.")); return; }
			const box = el("div"); box.style.cssText = "display:flex;flex-direction:column;gap:12px";
			for (const it of items) box.append(card(it));
			list.replaceChildren(box);
		} catch (e) {
			count.textContent = "?";
			list.replaceChildren(el("div", "dq-msg dq-bad", `Could not reach the queue: ${e?.message ?? e}`));
		}
	}

	async function loadOne() {
		head.firstChild.textContent = "Decision ";
		try {
			// An inline frame may not read one item on its own, so it finds this one in the open queue, then in the recent answers.
			const open = (await (await authFetch(`${BASE}/api/queue`, { cache: "no-store" })).json()).items || [];
			const it = open.find((x) => x.id === ITEM);
			if (it) { count.textContent = "open"; list.replaceChildren(card(it)); return; }
			const done = (await (await authFetch(`${BASE}/api/recent`, { cache: "no-store" })).json()).items || [];
			const was = done.find((x) => x.id === ITEM);
			if (!was) { count.textContent = "?"; list.replaceChildren(el("div", "dq-msg dq-bad", `No such question: ${ITEM}`)); return; }
			count.textContent = "answered";
			const c = el("div", "dq-card");
			c.append(el("div", `dq-kind ${was.kind}`, KIND[was.kind] || was.kind), el("div", "dq-title", was.title));
			const how = was.status === "answered-on-card" ? "Answered on its question card in T3." : `Answered: ${was.answer?.label ?? ""}${was.answer?.note ? ` (${was.answer.note})` : ""}.`;
			c.append(el("div", "dq-msg dq-ok", how));
			list.replaceChildren(c);
		} catch (e) {
			count.textContent = "?";
			list.replaceChildren(el("div", "dq-msg dq-bad", `Could not reach the queue: ${e?.message ?? e}`));
		}
	}

	// No newline: one plain block. Otherwise runs of "- " or "• " lines become one list; other lines are paragraphs. Text goes in as textContent only.
	function context(text) {
		const s = String(text);
		const box = el("div", "dq-ctx");
		if (!s.includes("\n")) { box.textContent = s; return box; }
		let ul = null;
		for (const raw of s.split("\n")) {
			const line = raw.replace(/\r$/, "");
			const b = /^(?:- |• )(.*)$/.exec(line);
			if (b) { if (!ul) { ul = el("ul"); box.append(ul); } ul.append(el("li", "", b[1])); continue; }
			ul = null;
			if (line.trim()) box.append(el("p", "", line));
		}
		return box;
	}

	// A link out of this view: one of the page's own addresses. T3 Code's web and desktop clients show this view in a sandboxed frame that
	// opens only an http(s) link (it hands it to the app's browser), so that is what a frame gets. None carries a key: the frame holds only the
	// weak view key (never the page key), which cannot sign a browser in, so a link opens signed in only where the browser already holds the page's cookie.
	const linkOut = (text, path) => { const a = el("a", "dq-meta dq-link", text); a.href = `${BASE}${path}`; a.target = "_blank"; a.rel = "noopener"; return a; };
	// T3 Code's phone app shows this view as the top document of its own web view, not in a frame, and hands any link that is not http(s)
	// to the phone's OS, which opens the app's own link (t3code://threads/…) in the app itself: the thread opens in place, no browser.
	// So the top document links straight to the app link the server made; a frame (T3's web and desktop clients) uses /open.
	const TOP = (() => { try { return window.parent === window; } catch { return false; } })();
	// The app link's shape, as the server checks it (src/web/thread-links.ts isAppLink): a lowercase scheme no browser runs or loads, then
	// only unreserved characters, ":", "/" and percent escapes. Anything else never becomes an href.
	const APP_LINK = /^(?!(?:javascript|vbscript|data|file|blob|about|filesystem|https?|wss?|ftp):)[a-z][a-z0-9+.-]{0,31}:\/\/[A-Za-z0-9._~:%/-]{1,1024}$/;
	// The thread's own link: the app link in T3's phone app; else the page's /open route, which sends the device on (src/web/thread-links.ts).
	// No target: an app link is a navigation the app's web view hands to the OS, and a new window would drop it.
	const threadLink = (x) => {
		if (TOP && typeof x?.app === "string" && APP_LINK.test(x.app)) { const a = el("a", "dq-meta dq-link", "Open the thread"); a.href = x.app; return a; }
		return typeof x?.open === "string" && /^\/open\/[^/?#]+\/[^/?#]+$/.test(x.open) ? linkOut("Open the thread", x.open) : null;
	};

	function card(it) {
		const c = el("div", "dq-card");
		c.append(el("div", `dq-kind ${it.kind}`, `${KIND[it.kind] || it.kind}${it.urgent === false && !it.secret && !it.cardRequest && !/^\s*(approval|secret)\s*$/i.test(it.tag || "") ? " · NOT URGENT" : ""}`), el("div", "dq-title", it.title));
		if (it.context) c.append(context(it.context));
		const imgs = (it.evidence || []).filter((x) => x.type === "image" && x.path);
		if (imgs.length) {
			const ev = el("div", "dq-ev");
			for (const x of imgs) { const i = el("img"); i.src = `${BASE}/evidence/${encodeURIComponent(it.id)}/${encodeURIComponent(x.path)}${kq}`; i.alt = x.caption || "evidence"; i.onerror = () => i.replaceWith(el("div", "dq-meta", "Image evidence shows on the full queue page.")); ev.append(i); }
			c.append(ev);
		}
		const own = threadLink(it);
		if (it.secret) {
			// The server says `ended` once no secret box waits in the thread (it timed out, or was cancelled or answered): never point at a box that is gone.
			if (it.secretRequest === "ended") c.append(el("div", "dq-msg dq-expired", "Request expired. Its secret box is closed: ask the thread to reopen it."));
			else c.append(el("div", "dq-ctx", "A secret is entered in its own thread, never here."));
			if (own) c.append(own);
			return c;
		}
		if (it.cardRequest) { c.append(el("div", "dq-ctx", "Act on the question card itself, in its thread. This question closes only when the card does.")); if (own) c.append(own); return c; }
		const m = it.mirrored;
		if (m) {
			const where = el("div", "dq-meta", `${m.threadTitle} · ${m.server}`);
			c.insertBefore(where, c.children[1]);
			// An approval's command, exactly as T3 holds it: what is read is what would be approved.
			if ((m.type === "approval" || m.type === "goal") && m.command) c.append(el("pre", "dq-cmd", m.command));
			// Cards and approvals are answered on the full page, behind a confirmation the server checks. Never from a frame.
			c.append(el("div", "dq-msg", m.type === "question" ? "Answer this question card on the full queue page." : "Approvals and goals are answered on the full queue page, never here."));
			c.append(linkOut("Open the queue page", "/"));
			const t = threadLink(m);
			if (t) c.append(t);
			return c;
		}
		let choice = Number.isInteger(it.recommended) ? it.recommended : -1;
		const go = el("button", "dq-go"); go.type = "button";
		const label = () => { go.disabled = choice < 0; go.textContent = choice < 0 ? "Pick an option" : `Answer ${it.options[choice].label}`; };
		const rows = (it.options || []).map((o, i) => {
			const row = el("label", "dq-opt");
			const radio = el("input"); radio.type = "radio"; radio.name = `o-${it.id}`; radio.checked = i === choice;
			const txt = el("div"); const l = el("div", "dq-l", o.label);
			if (i === it.recommended) l.append(el("span", "dq-rec", "RECOMMENDED"));
			txt.append(l); if (o.detail) txt.append(el("div", "dq-d", o.detail));
			row.append(radio, txt); if (i === choice) row.classList.add("sel");
			radio.addEventListener("change", () => { choice = i; rows.forEach((r, j) => r.classList.toggle("sel", j === i)); label(); });
			c.append(row); return row;
		});
		const note = el("textarea"); note.placeholder = "Note to the thread (optional)"; note.rows = 1; note.setAttribute("aria-label", "Note to the thread");
		const msg = el("div", "dq-msg");
		label();
		go.addEventListener("click", async () => {
			go.disabled = true; msg.className = "dq-msg"; msg.textContent = "Sending…";
			try {
				// A choice and a note, and nothing else: the server refuses any other field from a frame.
				const r = await authFetch(`${BASE}/api/items/${encodeURIComponent(it.id)}/answer`, { method: "POST", headers: { "content-type": "application/json", "x-decision-queue": "1" }, body: JSON.stringify({ choice, note: note.value }) });
				let b = {};
				// EMPTY_CATCH_OK: the body only adds detail; r.ok and r.status already say whether the answer delivered.
				try { b = await r.json(); } catch { b = {}; }
				if (r.ok) { c.dataset.answered = "1"; msg.className = "dq-msg dq-ok"; msg.textContent = b.to === "thread" ? `Answered: ${b.choice || ""}. Sent to its thread.` : `Answered: ${b.choice || ""}. Recorded; the wake to the Steward is queued.`; go.textContent = "Done"; for (const row of rows) row.querySelector("input").disabled = true; note.disabled = true; }
				else { msg.className = "dq-msg dq-bad"; msg.textContent = b.error || `HTTP ${r.status}`; go.disabled = false; }
			} catch (e) { msg.className = "dq-msg dq-bad"; msg.textContent = `Could not send: ${e?.message ?? e}`; go.disabled = false; }
		});
		c.append(note, go, msg);
		if (own) c.append(own);
		return c;
	}
	if (DASH) { dash(); return; }
	reload.addEventListener("click", load);
	load();

	function dash() {
		head.firstChild.textContent = "Decisions ";
		const health = el("details", "dq-health");
		wrap.insertBefore(health, list);
		const tabs = el("div", "dq-tabs");
		const names = ["Waiting", "Rulings", "Recent"];
		let tab = "Waiting";
		const btns = names.map((n) => { const b = el("button", "dq-tab", n); b.type = "button"; b.addEventListener("click", () => { tab = n; paint(); show(); }); tabs.append(b); return b; });
		wrap.insertBefore(tabs, list);
		const panes = { Waiting: el("div"), Rulings: el("div"), Recent: el("div") };
		panes.Waiting.style.cssText = "display:flex;flex-direction:column;gap:12px";
		list.replaceChildren(panes.Waiting, panes.Rulings, panes.Recent);
		const paint = () => { btns.forEach((b, i) => b.classList.toggle("on", names[i] === tab)); for (const n of names) panes[n].style.display = n === tab ? "" : "none"; };
		// One line per machine the queue can't reach (a sleeping laptop), so "clear" never claims more than it can see.
		const away = el("div", "dq-msg dq-away");
		panes.Waiting.append(away);
		const cards = new Map(); // item ID -> its card; kept while he is choosing, so a refresh never resets his pick
		let lastHealth, lastHealthLimits;
		let focused = false;
		const bad = (pane, e) => pane.replaceChildren(el("div", "dq-msg dq-bad", `Could not reach the queue: ${e?.message ?? e}`));
		async function waiting() {
			try {
				const q = await (await authFetch(`${BASE}/api/queue`, { cache: "no-store" })).json();
				const h = q.health;
				lastHealth = h; lastHealthLimits = q.healthLimits;
				paintHealth(health, h, q.healthLimits);
				const hm = (t) => { const d = new Date(t); return isNaN(d) ? "a while" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };
				const gone = q.unreachable || [];
				away.style.display = gone.length ? "" : "none";
				away.replaceChildren(...gone.map((u) => el("div", "", `${u.server[0].toUpperCase()}${u.server.slice(1)} not reachable since ${hm(u.since)} (asleep?). What waits there may be missing or out of date; it shows when ${u.server} wakes.`)));
				const items = [...(q.items || []), ...(q.cards || []).map(fromCard)];
				count.textContent = items.length ? `${items.length} waiting` : "clear";
				const ids = new Set(items.map((i) => i.id));
				for (const [id, c] of cards) if (!ids.has(id) && !c.dataset.answered) { c.remove(); cards.delete(id); }
				for (const it of items) {
					const old = cards.get(it.id);
					// A mirrored card that changed under the same ID (a new command, reordered options) is redrawn, so he
					// sees and answers the live version, never the stale one. One he just answered here stays as it is.
					if (old && (old.dataset.answered || !it.mirrored || old.dataset.sig === it.mirrored.sig)) continue;
					const c = card(it);
					if (it.mirrored) c.dataset.sig = it.mirrored.sig;
					cards.set(it.id, c);
					if (old) old.replaceWith(c); else panes.Waiting.append(c);
				}
				panes.Waiting.querySelector(".dq-empty")?.remove();
				if (!cards.size) panes.Waiting.append(el("div", "dq-empty", "Nothing waiting. The queue is clear."));
				if (ITEM && !focused && cards.has(ITEM)) { focused = true; cards.get(ITEM).classList.add("dq-focus"); }
			} catch (e) {
				paintHealth(health, lastHealth ? { ...lastHealth, unknown: [...(lastHealth.unknown || []), "Queue refresh unavailable"] } : null, lastHealthLimits);
				count.textContent = "?"; if (!cards.size) bad(panes.Waiting, e);
			}
		}
		async function rulings() {
			try {
				const r = (await (await authFetch(`${BASE}/api/rulings`, { cache: "no-store" })).json()).rulings || [];
				const live = r.filter((x) => x.status !== "retired");
				live.sort((a, b) => (a.status === b.status ? 0 : a.status === "in-force" ? -1 : 1));
				if (!live.length) { panes.Rulings.replaceChildren(el("div", "dq-empty", "No rulings in force.")); return; }
				panes.Rulings.replaceChildren(...live.map((x) => {
					const row = el("div", "dq-row");
					const meta = `${x.id} · ${x.expired ? `expired ${x.expires}` : x.status === "in-force" ? (x.confirmed ? "in force" : "in force, unconfirmed") : "proposed"}${x.cited ? ` · cited ${x.cited}×` : ""}`;
					row.append(el("div", "dq-meta", meta), el("div", "dq-ctx", x.decides));
					return row;
				}), el("div", "dq-meta", "Change a ruling on the queue page."));
			} catch (e) { bad(panes.Rulings, e); }
		}
		async function recent() {
			try {
				const items = (await (await authFetch(`${BASE}/api/recent`, { cache: "no-store" })).json()).items || [];
				if (!items.length) { panes.Recent.replaceChildren(el("div", "dq-empty", "Nothing answered yet.")); return; }
				panes.Recent.replaceChildren(...items.map((it) => {
					const row = el("div", "dq-row");
					const when = it.at ? new Date(it.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
					const how = it.status === "answered-on-card" ? "answered on its question card" : `${it.answer?.label ?? ""}${it.answer?.note ? ` · ${it.answer.note}` : ""}`;
					row.append(el("div", "dq-meta", `${it.id} · ${when}`), el("div", "dq-l", it.title), el("div", "dq-ctx", how));
					return row;
				}));
			} catch (e) { bad(panes.Recent, e); }
		}
		const show = () => (tab === "Waiting" ? waiting() : tab === "Rulings" ? rulings() : recent());
		reload.addEventListener("click", show);
		paint();
		waiting();
		// Keep the count and the open tab current while he is looking; a hidden frame does no work.
		setInterval(() => { if (document.visibilityState !== "hidden") { waiting(); if (tab !== "Waiting") show(); } }, 20000);
	}
})();
