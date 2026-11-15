// The decision queue for T3's inline chat frames. The Steward renders only a two-line shell that loads this file, so
// showing the queue costs it almost nothing; questions come live from /api/queue. Theme comes from T3's CSS variables.
// This view holds only the VIEW key, and the SERVER enforces what that may do (src/web/view-key.ts): it may GET /api/queue, /api/recent and
// /api/rulings, and POST an item's answer (a choice, never a note), snooze, un-snooze, direction and dismiss, and nothing else. The pill buttons along
// each card's bottom edge, and on each row of the Snoozed tab, do those in place: one tap is one request, no confirmation, no page change. It never
// answers a card or an approval, never saves a ruling and never reads one item on its own: those are done on the full queue page, which the links open.
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
	const MIN_HEIGHT = "700px";
	const KIND = { "only-you": "ONLY YOU", product: "PRODUCT REVIEW", ruling: "SETS A RULING", idea: "IDEA", thread: "FROM A THREAD", approval: "APPROVAL", goal: "GOAL PROPOSAL", secret: "SECRET · IN ITS THREAD", link: "LINK · IN ITS THREAD" };
	// A card waiting in another thread, shaped like a queue item. It is shown here and answered on the full page.
	const fromCard = (c) => ({ id: c.id, kind: c.type === "question" ? "thread" : c.type, title: c.header || "Question", context: c.question, options: c.options, recommended: c.recommended, mirrored: c });
	const css = `*{box-sizing:border-box}body{font-family:var(--font-sans);margin:0}
.dq{display:flex;flex-direction:column;gap:12px}.dq-head{display:flex;align-items:center;gap:8px;font-weight:700;font-size:16px}
.dq-count{font-family:var(--font-mono);font-size:12px;padding:2px 8px;border-radius:999px;background:var(--secondary);color:var(--secondary-foreground);font-weight:500}
.dq-reload{margin-left:auto}
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
.dq-tabs{display:flex;flex-wrap:nowrap;gap:4px;overflow-x:auto}.dq-tab{font:inherit;font-size:12px;font-weight:600;background:none;border:1px solid var(--border);color:var(--muted-foreground);border-radius:999px;padding:6px 10px;min-height:34px;white-space:nowrap;flex:0 0 auto;cursor:pointer}.dq-tab-n{margin-left:4px;font-family:var(--font-mono);font-size:11px;font-weight:500}
.dq-tab.on{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground)}.dq-focus{outline:2px solid var(--primary);outline-offset:2px}
.dq-row{border-bottom:1px solid var(--border);padding:10px 0;display:flex;flex-direction:column;gap:4px}.dq-row:last-child{border-bottom:0}
.dq-meta{font-family:var(--font-mono);font-size:11px;color:var(--muted-foreground)}
.dq-pill,.dq-btn,.dq-reload,.dq-go{font:inherit;font-size:13px;font-weight:500;line-height:1.2;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:40px;padding:8px 18px;border-radius:999px;border:1px solid color-mix(in srgb,var(--foreground) 35%,transparent);background:color-mix(in srgb,var(--foreground) 6%,transparent);color:var(--foreground);text-decoration:none;cursor:pointer}
.dq-pill:hover,.dq-btn:hover:not(:disabled),.dq-reload:hover{background:color-mix(in srgb,var(--foreground) 13%,transparent)}.dq-pill:focus-visible,.dq-btn:focus-visible,.dq-reload:focus-visible,.dq-go:focus-visible,.dq-tab:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.dq-btn.rec,.dq-go{background:var(--primary);border-color:var(--primary);color:var(--primary-foreground)}.dq-btn.rec:hover:not(:disabled),.dq-go:hover:not(:disabled){background:color-mix(in srgb,var(--primary) 88%,var(--foreground))}
.dq-go{font-size:15px;font-weight:600;min-height:48px;padding:12px 22px}.dq-btn:disabled,.dq-go:disabled{opacity:.5;cursor:default}.dq-card>.dq-pill{align-self:flex-start}
.dq-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;border-top:1px solid var(--border);margin-top:2px;padding-top:12px}
.dq-dir{display:flex;flex-direction:column;gap:8px}
.dq-msg{font-size:13px}.dq-expired{color:var(--warning);font-weight:600}.dq-ok{color:var(--success)}.dq-bad{color:var(--destructive)}.dq-empty{color:var(--muted-foreground);font-size:14px;padding:12px 0}.dq-away{color:var(--muted-foreground)}`;
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
	// The Decisions view is a tall pane. The shell that loads this script gives its root a minimum height, but a shell written by hand may not,
	// and a frame with no height reads as a thin strip. So the view sets it on its own root and on the body when it mounts, whatever the shell said.
	if (DASH) { root.style.minHeight = MIN_HEIGHT; try { document.body.style.minHeight = MIN_HEIGHT; } catch { /* a page with no body keeps the root's height */ } }
	const wrap = el("div", "dq");
	const head = el("div", "dq-head", "Decisions ");
	const count = el("span", "dq-count", "…");
	const reload = el("button", "dq-reload", "Refresh"); reload.type = "button";
	const list = el("div");
// How many cards still wait, so a tap that settles one updates the count at once; `refresh` re-reads the queue (the Decisions view sets it).
let remaining = 0;
let refresh = () => {};
head.append(count, reload); wrap.append(head, list); root.replaceChildren(wrap);

	async function load() {
		list.replaceChildren(el("div", "dq-empty", "Loading the queue…"));
		if (ITEM) return loadOne();
		try {
			const q = await (await authFetch(`${BASE}/api/queue`, { cache: "no-store" })).json();
			const items = q.items || [];
remaining = items.length;
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
			const q = await (await authFetch(`${BASE}/api/queue`, { cache: "no-store" })).json();
			const it = (q.items || []).find((x) => x.id === ITEM);
			if (it) { count.textContent = "open"; list.replaceChildren(card(it)); return; }
			// A snoozed question is not answered and not on the active list: say when it returns. The Decisions view's Snoozed tab brings it back in place; this one-question view links to the full page.
			const later = (q.snoozed || []).find((x) => x.id === ITEM);
			if (later) {
				count.textContent = "snoozed";
				const c = el("div", "dq-card");
				c.append(el("div", `dq-kind ${later.kind}`, KIND[later.kind] || later.kind), el("div", "dq-title", later.title), el("div", "dq-msg dq-away", `Snoozed. It returns ${returnsAt(later.snooze.until)}.`), fullPage(later, "Un-snooze"));
				list.replaceChildren(c);
				return;
			}
			const done = (await (await authFetch(`${BASE}/api/recent`, { cache: "no-store" })).json()).items || [];
			const was = done.find((x) => x.id === ITEM);
			if (!was) { count.textContent = "?"; list.replaceChildren(el("div", "dq-msg dq-bad", `No such question: ${ITEM}`)); return; }
			count.textContent = was.status === "dismissed" ? "dismissed" : "answered";
			const c = el("div", "dq-card");
			c.append(el("div", `dq-kind ${was.kind}`, KIND[was.kind] || was.kind), el("div", "dq-title", was.title));
			const how = was.status === "answered-on-card" ? "Answered on its question card in T3." : was.status === "dismissed" ? `Dismissed${was.dismissal?.note ? ` (${was.dismissal.note})` : ""}. Nothing was answered.` : `Answered: ${was.answer?.label ?? ""}${was.answer?.note ? ` (${was.answer.note})` : ""}.`;
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

	// When a snoozed question returns, in this device's own time zone.
	const returnsAt = (iso) => { const d = new Date(iso); return isNaN(d) ? "later" : d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
	// A link out of this view: one of the page's own addresses. T3 Code's web and desktop clients show this view in a sandboxed frame that
	// opens only an http(s) link (it hands it to the app's browser), so that is what a frame gets. Only the thread link (`/open`) carries a key
	// (`withKey`): the view key this script already holds, never the page key, which the server accepts on /open alone (src/web/view-key.ts) and which
	// signs nothing in, so a new tab opens the thread from any browser. Every other link carries none: the weak view key cannot sign a browser in, so
	// the queue page and an item open signed in only where the browser already holds the page's cookie.
	const linkOut = (text, path, withKey) => { const a = el("a", "dq-pill", text); a.href = `${BASE}${path}${withKey ? kq : ""}`; a.target = "_blank"; a.rel = "noopener"; return a; };
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
		if (TOP && typeof x?.app === "string" && APP_LINK.test(x.app)) { const a = el("a", "dq-pill", "Open the thread"); a.href = x.app; return a; }
		return typeof x?.open === "string" && /^\/open\/[^/?#]+\/[^/?#]+$/.test(x.open) ? linkOut("Open the thread", x.open, true) : null;
	};

	// A card the view cannot act on (a snoozed question, shown on its own): the thread link and one link to the full queue page.
	const fullPage = (it, text) => {
		const row = el("div", "dq-actions");
		const own = threadLink(it);
		if (own) row.append(own);
		row.append(linkOut(text, `/item/${encodeURIComponent(it.id)}`));
		return row;
	};

	// The one POST this view makes: one of the view key's writes on one item (src/web/view-key.ts). Its reply is { ok, status, b } with b the JSON body, or {}.
	async function postItem(id, action, body) {
		const r = await authFetch(`${BASE}/api/items/${encodeURIComponent(id)}/${action}`, { method: "POST", headers: { "content-type": "application/json", "x-decision-queue": "1" }, body: JSON.stringify(body) });
		let b = {};
		// EMPTY_CATCH_OK: the body only adds detail; r.ok and r.status already say whether it was recorded.
		try { b = await r.json(); } catch { b = {}; }
		return { ok: r.ok, status: r.status, b };
	}

	// One tap on Snooze puts the question off for this long. It comes back by itself and is shown again if urgent. The full page offers the others.
	const SNOOZE_TAP_MS = 3600000;
	const btn = (text, cls, onTap) => { const b = el("button", `dq-btn${cls ? ` ${cls}` : ""}`, text); b.type = "button"; b.addEventListener("click", onTap); return b; };

	// The little buttons along a card's bottom edge, which act in place: each option, Snooze, Dismiss, Direction, then the thread link. One tap is one
	// request: no confirmation, no second button, no page change. Direction needs a note, so it opens a field in the same card and Send is the one tap
	// after it. A secret and a card pointer are settled in their own thread: they get Snooze and the thread link. The card then says what happened
	// (answered, snoozed, dismissed), or the error shows on it and the buttons come back.
	function panel(it, c, settles) {
		const msg = el("div", "dq-msg");
		const row = el("div", "dq-actions");
		const dir = el("div", "dq-dir"); dir.style.display = "none";
		const note = el("textarea"); note.placeholder = "Direction for the thread (no option chosen)"; note.rows = 2; note.setAttribute("aria-label", "Direction for the thread");
		const sendDir = el("button", "dq-go", "Send direction"); sendDir.type = "button";
		dir.append(note, sendDir);
		const taps = [];
		let sending = false;
		const lock = (on) => { sending = on; note.disabled = on; sendDir.disabled = on; for (const b of taps) b.disabled = on; };
		const tell = (cls, text) => { msg.className = `dq-msg ${cls}`.trim(); msg.textContent = text; };
		function done(text, extra, action) {
			// A snoozed card stays on screen saying so, but is replaced by a live one if the question comes back (see waiting()).
			c.dataset.answered = action === "snooze" ? "snoozed" : "1"; dir.remove();
			const own = threadLink(it);
			row.replaceChildren(...(own ? [own] : []), ...extra);
			tell("dq-ok", text);
			remaining = Math.max(0, remaining - 1);
			count.textContent = ITEM ? "done" : remaining ? `${remaining} waiting` : DASH ? "clear" : "0 waiting";
			refresh();
		}
		async function send(action, body, said) {
			if (sending) return;
			lock(true); tell("", "Sending…");
			try {
				const r = await postItem(it.id, action, body);
				if (r.ok) done(said(r.b), action === "snooze" ? [linkOut("Un-snooze", `/item/${encodeURIComponent(it.id)}`)] : [], action);
				else { tell("dq-bad", r.b.error || `HTTP ${r.status}`); lock(false); }
			} catch (e) { tell("dq-bad", `Could not send: ${e?.message ?? e}`); lock(false); }
		}
		const answered = (o) => (r) => `Answered: ${r.choice || o.label}. ${r.to === "thread" ? "Sent to its thread." : "Recorded; the wake to the Steward is queued."}`;
		if (settles) {
			(it.options || []).forEach((o, i) => {
				const b = btn(o.label, i === it.recommended ? "rec" : "", () => send("answer", { choice: i }, answered(o)));
				if (i === it.recommended) { b.setAttribute("aria-label", `${o.label} (recommended)`); b.setAttribute("title", "Recommended"); } else if (o.detail) b.setAttribute("title", o.detail);
				taps.push(b);
			});
		}
		taps.push(btn("Snooze", "", () => send("snooze", { until: new Date(Date.now() + SNOOZE_TAP_MS).toISOString() }, (r) => `Snoozed. It returns ${returnsAt(r.until)}.`)));
		if (settles) {
			taps.push(btn("Dismiss", "", () => send("dismiss", {}, () => "Dismissed. It is off the queue and nothing was answered.")));
			taps.push(btn("Direction", "", () => { dir.style.display = dir.style.display === "none" ? "" : "none"; if (dir.style.display === "") note.focus?.(); }));
		}
		sendDir.addEventListener("click", () => {
			const text = note.value.trim();
			if (!text) { tell("dq-bad", "Write your direction first. It goes to the Steward with no option chosen."); return; }
			send("direction", { note: text }, () => "Direction sent. The Steward reads your note; no option was chosen.");
		});
		const own = threadLink(it);
		row.append(...taps, ...(own ? [own] : []));
		return settles ? [dir, msg, row] : [msg, row];
	}

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
		if (it.secret) {
			// The server says `ended` once no secret box waits in the thread (it timed out, or was cancelled or answered): never point at a box that is gone.
			if (it.secretRequest === "ended") c.append(el("div", "dq-msg dq-expired", "Request expired. Its secret box is closed: ask the thread to reopen it."));
			else c.append(el("div", "dq-ctx", "A secret is entered in its own thread, never here."));
			c.append(...panel(it, c, false));
			return c;
		}
		if (it.cardRequest) { c.append(el("div", "dq-ctx", "Act on the question card itself, in its thread. This question closes only when the card does.")); c.append(...panel(it, c, false)); return c; }
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
		// What each option means, as the card showed it before the options became buttons: the buttons carry the labels, this carries the detail.
		for (const o of it.options || []) if (o.detail) c.append(el("div", "dq-d", `${o.label}: ${o.detail}`));
		c.append(...panel(it, c, true));
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
		// Snoozed sits right after Waiting, with a count as Waiting has, so what is put off is one tap from what is waiting.
		const names = ["Waiting", "Snoozed", "Rulings", "Recent"];
		let tab = "Waiting";
		const btns = names.map((n) => {
			const b = el("button", "dq-tab", n); b.type = "button";
			if (n === "Waiting" || n === "Snoozed") b.append(el("span", "dq-tab-n", "…"));
			b.addEventListener("click", () => { tab = n; paint(); show(); }); tabs.append(b); return b;
		});
		const tabCount = (n, v) => { const b = btns[names.indexOf(n)]; b.querySelector(".dq-tab-n").textContent = String(v); b.setAttribute("aria-label", `${n}, ${v}`); };
		wrap.insertBefore(tabs, list);
		const panes = { Waiting: el("div"), Snoozed: el("div"), Rulings: el("div"), Recent: el("div") };
		panes.Waiting.style.cssText = "display:flex;flex-direction:column;gap:12px";
		panes.Snoozed.style.cssText = "display:flex;flex-direction:column;gap:12px";
		list.replaceChildren(panes.Waiting, panes.Snoozed, panes.Rulings, panes.Recent);
		const paint = () => { btns.forEach((b, i) => b.classList.toggle("on", names[i] === tab)); for (const n of names) panes[n].style.display = n === tab ? "" : "none"; };
		// One line per machine the queue can't reach (a sleeping laptop), so "clear" never claims more than it can see.
		const away = el("div", "dq-msg dq-away");
		panes.Waiting.append(away);
		const cards = new Map(); // item ID -> its card; kept while he is choosing, so a refresh never resets his pick
		let lastHealth, lastHealthLimits;
		let focused = false;
		const bad = (pane, e) => pane.replaceChildren(el("div", "dq-msg dq-bad", `Could not reach the queue: ${e?.message ?? e}`));
		// One card per snoozed question: when it returns, and the one-press actions its kind supports. Bring back now puts it on the waiting list at once; Dismiss
		// closes it, except for a secret or a card pointer, which are settled in their own thread (the server refuses them): those get Bring back now and the thread link,
		// as Waiting's panel gives them Snooze and the thread link. Both are the view key's own writes (src/web/view-key.ts). The server decides; on success the view reads the queue again.
		// A card is made once per item and kept (snoozedCards), so a redraw never drops a press in flight: its lock lives with the card.
		function snoozedCard(it) {
			const c = el("div", "dq-card");
			const title = el("div", "dq-title", it.title);
			const meta = el("div", "dq-meta");
			const msg = el("div", "dq-msg");
			const row = el("div", "dq-actions");
			const taps = [];
			let sending = false;
			const lock = (on) => { sending = on; for (const b of taps) b.disabled = on; };
			async function act(action, said) {
				if (sending) return;
				lock(true); msg.className = "dq-msg"; msg.textContent = "Sending…";
				try {
					const r = await postItem(it.id, action, {});
					if (r.ok) { msg.className = "dq-msg dq-ok"; msg.textContent = said; refresh(); return; }
					msg.className = "dq-msg dq-bad"; msg.textContent = r.b.error || `HTTP ${r.status}`;
				} catch (e) { msg.className = "dq-msg dq-bad"; msg.textContent = `Could not send: ${e?.message ?? e}`; }
				lock(false);
			}
			taps.push(btn("Bring back now", "rec", () => act("unsnooze", "Back on the waiting list.")));
			if (!it.secret && !it.cardRequest) taps.push(btn("Dismiss", "", () => act("dismiss", "Dismissed. It is off the queue and nothing was answered.")));
			const own = threadLink(it);
			row.append(...taps, ...(own ? [own] : []));
			c.append(el("div", `dq-kind ${it.kind}`, KIND[it.kind] || it.kind), title, meta);
			if (it.context) c.append(context(it.context));
			c.append(msg, row);
			return { node: c, update: (x) => { title.textContent = x.title; meta.textContent = `${x.thread} · returns ${returnsAt(x.snooze.until)}`; } };
		}
		const snoozedCards = new Map(); // item ID -> its card
		function paintSnoozed(rows) {
			tabCount("Snoozed", rows.length);
			const soonest = [...rows].sort((a, b) => String(a.snooze.until).localeCompare(String(b.snooze.until)));
			const ids = new Set(soonest.map((i) => i.id));
			for (const id of [...snoozedCards.keys()]) if (!ids.has(id)) snoozedCards.delete(id);
			const nodes = soonest.map((it) => {
				let k = snoozedCards.get(it.id);
				if (!k) { k = snoozedCard(it); snoozedCards.set(it.id, k); }
				k.update(it);
				return k.node;
			});
			panes.Snoozed.replaceChildren(...(nodes.length ? nodes : [el("div", "dq-empty", "Nothing snoozed.")]));
		}
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
				remaining = items.length;
count.textContent = items.length ? `${items.length} waiting` : "clear";
				tabCount("Waiting", items.length);
				const ids = new Set(items.map((i) => i.id));
				const put = new Set((q.snoozed || []).map((i) => i.id));
				// A card he answered here stays as it is. One he snoozed is a note that it was put off: it stays while the question is snoozed, and goes when the question is in neither list (dismissed from the Snoozed tab, or settled elsewhere).
				for (const [id, c] of cards) if (!ids.has(id) && (!c.dataset.answered || (c.dataset.answered === "snoozed" && !put.has(id)))) { c.remove(); cards.delete(id); }
				for (const it of items) {
					const old = cards.get(it.id);
					// A mirrored card that changed under the same ID (a new command, reordered options) is redrawn, so he
					// sees and answers the live version, never the stale one. One he just answered here stays as it is.
					// A card he snoozed here is a note that it was put off; when the question is back on the list (its time passed, or it was brought back) that note is replaced by the live card.
					const back = old?.dataset.answered === "snoozed";
					if (old && !back && (old.dataset.answered || !it.mirrored || old.dataset.sig === it.mirrored.sig)) continue;
					const c = card(it);
					if (it.mirrored) c.dataset.sig = it.mirrored.sig;
					cards.set(it.id, c);
					if (old) old.replaceWith(c); else panes.Waiting.append(c);
				}
				panes.Waiting.querySelector(".dq-empty")?.remove();
				if (!cards.size) panes.Waiting.append(el("div", "dq-empty", "Nothing waiting. The queue is clear."));
				paintSnoozed(q.snoozed || []);
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
					const how = it.status === "answered-on-card" ? "answered on its question card" : it.status === "dismissed" ? `dismissed${it.dismissal?.note ? ` · ${it.dismissal.note}` : ""}` : `${it.answer?.label ?? ""}${it.answer?.note ? ` · ${it.answer.note}` : ""}`;
					row.append(el("div", "dq-meta", `${it.id} · ${when}`), el("div", "dq-l", it.title), el("div", "dq-ctx", how));
					return row;
				}));
			} catch (e) { bad(panes.Recent, e); }
		}
		const show = () => (tab === "Waiting" || tab === "Snoozed" ? waiting() : tab === "Rulings" ? rulings() : recent());
// A tap that settled a card re-reads the queue, so the Snoozed tab and the counts follow at once.
refresh = waiting;
		reload.addEventListener("click", show);
		paint();
		waiting();
		// Keep the count and the open tab current while he is looking; a hidden frame does no work.
		setInterval(() => { if (document.visibilityState !== "hidden") { waiting(); if (tab !== "Waiting" && tab !== "Snoozed") show(); } }, 20000);
	}
})();
