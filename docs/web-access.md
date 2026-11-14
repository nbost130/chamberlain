# The page's key

The decision-queue page answers only a request that holds the install's **capability token**. It is 32 random bytes, made the first time the page
starts and kept in `secrets/web-token` (mode 0600). It exists because T3 shows the Decisions view in a sandboxed frame (origin `null`) that the page
has to let in, and without a secret any sandboxed page that could reach the port could read the queue and answer for you. The same key now closes the page to
anything else that can reach the port: another user on the machine, or any peer on your tailnet.

| Request | What it needs |
| --- | --- |
| `app.js`, `app.css`, `inline.js` | Nothing: they are the page's own code and carry no data. |
| The page (`/`, `/rulings`, `/item/<id>`, `/open/<server>/<threadId>`), the API, an item's evidence: **full authority** | The page key by one of: a signed cookie (a browser that opened a link), the `x-decision-token` header **on a same-origin request** (the page's own `Origin`), or (for a page load or an evidence image) `?k=<key>` in the address. For **evidence** the cookie counts only when the browser says the request comes from the page's own origin (`Sec-Fetch-Site: same-origin` or `none`): another port on the same host is "same-site", and cannot embed your evidence images with your cookie. |
| **No `Origin` header** (curl, an agent's fetch, a script) with only the `x-decision-token` header | **Inline authority only**, the same as a null-origin frame: `GET /api/queue`, `/api/recent`, `/api/rulings` and `POST /api/items/<id>/answer` with `choice` and an optional `note`. Everything else is `403`: card confirm and answer, ruling saves, `accept-all`, single-item reads, evidence, `/open/...` and any extra field in an answer. The page's own static HTML (`/`, `/rulings`, `/item/<id>`) holds no data and is still served to the page key in a header; a browser loads it by navigation with its cookie, which is full authority. A command-line tool that needs more opens a `?k=` link or sends the page's own `Origin`. |
| An inline frame (origin `null`) | The key in the `x-decision-token` header, nothing else (a cookie or `?k=` on an API call does not count), and inline authority only: the three reads and a plain answer. |
| The **view key** (`secrets/view-key`), in the header, with any `Origin` or none | Inline authority only, always, and never a cookie, a page load, a `?k=` link or evidence. It is the only key a Decisions post carries. |
| A page on any other origin | Refused (`403`), key or not. |

**Does the full page need the key too? Yes.** The page's HTML and script carry no data, but its API and evidence do, and the page is what you open in
a browser: gating it means a browser that has not been given the key sees one static "this page needs its link" page instead of a broken app, and a bookmark
works exactly as long as its cookie does. The cookie is the right way to do it on a phone: opening the link once signs that browser in for 400 days (the longest a
browser keeps one), and the address bar loses the key straight away (a `303` to the same page without `?k=`). The cookie is signed with a key derived from the token, so it
holds no token, and a rotation kills it. It is `HttpOnly` and `SameSite=Lax`, and `Secure` when the page is reached over https (for example through `tailscale serve`).

## Getting a link

```sh
chamberlain web link
```

reads the key (it never makes one: with none, because the page has never started, it says "start the page first (chamberlain web), then run web link again" and exits 1) and prints, for each address the page answers on (its bind address, each `allowedHosts` name and a `publicBase` if you set one):

- the **page link**, `<base>/?k=<key>`: open it once on each phone or laptop you use, in the browser or installed web app you use. After that the plain address works there.
- the **script tag** of the inline view for the Decisions thread's setup message ([decisions-thread-setup.md](decisions-thread-setup.md)).

Treat them like a password: anyone who holds one can read the queue and answer for you. They are never in a log: `chamberlain web` prints the address without a key and tells you to run this command.

The page link is the one place the page key appears. **It never goes into a Decisions post.** `chamberlain ask` puts the **view key** in the view it posts to the Decisions thread
(with the page up but no view key yet, it posts the one-line notice and says so on stderr, never a link that cannot work), and refuses to send any post whose text holds the page key. The inline
view passes the view key on every call. Its "Open the queue page" and "Open the thread" links (the second goes through `/open/<server>/<threadId>`, except in T3 Code's phone app, where it is the thread's app link; see [CONFIGURATION.md](CONFIGURATION.md)) carry no key: open them in a browser that already holds the cookie, because the weak view key cannot sign a browser in. **Evidence images in the Decisions view** loaded
with `?k=<key>`, which the page now accepts only for the page key, so a view posted after this change shows an item's image evidence on the full page only (a signed per-image address
for the frame belongs to the view-key work in issue #10).

## Rotating it

```sh
chamberlain web rotate-token
```

writes a new token (through a temporary file and a rename, mode 0600) and prints the new links. The running page follows the file, so there is **nothing to restart**. Every old page link,
browser cookie and already-rendered inline view **that carries the old page key** (every Decisions post made before the view key existed) stops working at once: a view says "this view's key no longer works" (it never shows an empty queue). A view that carries the view key is unaffected, because rotation does not touch `secrets/view-key`. Rotate when a link has been
somewhere it should not, when someone who held one should lose access, or on whatever schedule you like.

## Upgrading an existing install

Restart `chamberlain web` on the new build. It makes the token, and the view key, on that first start. From then on, **the page serves nothing without it**. What that means for what you already have:

| What you have | What happens | What to do |
| --- | --- | --- |
| The page's address in a **phone's or laptop's bookmark** (or home-screen icon) | It opens the static "this page needs its link" page (`401`), because the browser has no cookie yet. | Run `chamberlain web link` and open the page link **once** in that browser. The bookmark works again from then on, for 400 days, until a rotation. |
| **Posts already in the Decisions thread** (they carry the old **page** key in `inline.js?view=decisions&k=...`) | They keep working until the page key is rotated, with inline authority only (the same as before for a frame). Their copy of the page key is the leak: it sits in the thread's messages and transcript. | Rotate the page key (`chamberlain web rotate-token`; Nathan's call), then re-post the pinned view with the script tag from `chamberlain web link`, which carries the view key. |
| **Links already posted** into T3 threads (an old Decisions message with `inline.js?view=decisions...`) | The script still loads (it is static) but its calls carry no key, so it says **"this view's key no longer works ... run `chamberlain web link`"** (in a banner that stays on screen) and shows no questions. Nothing is lost: the questions are in the database and on the page. | New questions post views that carry the key on their own. To bring the pinned view back, re-send the Decisions thread's setup message with the script tag from `chamberlain web link`. |
| **Inline cards already shown** in a thread | A frame that is still running the previous build's script cannot read the page's `401` (it is plain text on purpose): on its next refresh its count turns to **"?"** and, if no question is on screen, it says **"could not reach the queue"**; an answer sent from it fails with **"HTTP 401"**. It never says the queue is clear. A frame that is re-rendered says "this view's key no longer works". Nothing on screen is the live queue. | Re-open the thread's latest message, or send the setup message again. |
| `chamberlain ask`, the daemon, the Steward's wakes, `afk`, `ruling`, `decided`, every command-line tool | **Keep working, unchanged.** They read the database, not the page. | Nothing. |
| Answers already given, rulings, the queue itself | Untouched: the database is not changed. | Nothing. |
| A **page that is still the old build** | Ignores the key and answers as before. | Restart it on the new build. |

**The one step that gets you back in: `chamberlain web link`, then open the link it prints.** For the Decisions thread, also paste the script tag it prints into the setup message.
If you are not sure the upgrade worked: `curl -s -o /dev/null -w '%{http_code}\n' http://<host>:<port>/api/queue` should print `401`, and
`printf 'header = "x-decision-token: %s"\n' "$(cat ~/.config/chamberlain/secrets/web-token)" | curl -s -K - http://<host>:<port>/api/queue`
should print the queue (the key goes in through stdin, not in the command line, where other users' `ps` would show it).

## Where the key is kept, and what it does not do

`secrets/web-token` is one of the config directory's secrets ([CONFIGURATION.md](CONFIGURATION.md#secrets)): mode 0600 in a 0700 directory, never logged, never in the events table, redacted from the
output of the command that posts the view. A token file that is not exactly 0600 is not trusted, and the page accepts nothing until it is fixed (it fails closed).

**The page key is not in the Decisions thread any more.** What is in the html of a Decisions post, and so in the thread's messages, its `html_render` input and the Decisions agent's transcript, is the **view key** (`secrets/view-key`, made the same way, mode 0600, never replaced by a start or a rotation of the page key). Anyone who holds an `orchestration:read` token on that T3 server (the Steward included, since its thread tools read every thread) can read it there, so it buys only what an inline frame may do: read the queue, recent answers and rulings, and plain-answer a question. It never opens the page, an item, evidence, a card or a ruling. (Posts made before this change carry the old page key; see the upgrade table above.)
