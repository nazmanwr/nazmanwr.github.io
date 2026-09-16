# nazmanwr.github.io

Portfolio site and client demo launcher. Plain HTML, CSS and JavaScript — no build
step, no dependencies. Push to `main` and GitHub Pages serves it within a minute.

**Live:** https://nazmanwr.github.io
**Launcher:** https://nazmanwr.github.io/demos/

---

## Read this first

The repository is **public** — it has to be, for free GitHub Pages. Demos are
*unlisted* (hidden from search engines, excluded from the public project list,
given unguessable URLs), but they are **not private**. Anyone who opens this
repo on GitHub can read every demo's source.

Fine for work-in-progress. **Not** for anything under NDA. If a demo needs to be
genuinely inaccessible, that's GitHub Pro with a private repo, or a host with
real authentication — not this.

---

## Adding a demo

1. **Copy the template** into a new folder:

   ```powershell
   Copy-Item -Recurse demos\_template demos\acme-onboarding-7f3a91
   ```

   The random suffix is what makes the URL unguessable. Six hex characters is
   plenty. Get one with:

   ```powershell
   -join ((48..57) + (97..102) | Get-Random -Count 6 | ForEach-Object { [char]$_ })
   ```

2. **Build the demo** in that folder's `index.html`. It's a normal HTML page —
   inline your CSS and JS, or add files next to it. Keep everything inside the
   folder so the demo stays self-contained.

   For a slide deck, uncomment the `deck.js` line in the `<head>` and use:

   ```html
   <div class="deck" data-deck>
     <section class="slide">…</section>
     <section class="slide">…</section>
   </div>
   ```

   `deck.js` builds the nav and wires up swipe, arrow keys and dots itself.

3. **Register it** in `data/demos.json`:

   ```json
   {
     "title": "Onboarding flow",
     "client": "Acme",
     "type": "app",
     "slug": "acme-onboarding-7f3a91",
     "date": "2026-10-02",
     "notes": "Three-step signup, tap through it."
   }
   ```

   `type` is `app` (interactive), `deck` (slides), or `link` (hosted elsewhere —
   set `url` instead of `slug`). External links open in a new tab rather than an
   iframe, because most live apps block embedding.

4. **Bump `VERSION` in `sw.js`** — `v1` → `v2`. This is the step that's easy to
   forget and annoying when you do: without it, an iPad that has visited before
   keeps serving the old cached build.

5. Commit and push:

   ```powershell
   git add -A
   git commit -m "Add Acme onboarding demo"
   git push
   ```

---

## Editing the portfolio

Look for `<!-- EDIT: ... -->` comments — they mark every block meant to change.

| What | Where |
| --- | --- |
| Name, tagline, hero copy | `index.html` |
| Full project grid | `work.html` |
| Bio, services, contact links | `about.html` |
| Colours and type | `assets/css/site.css` (the `:root` tokens at the top) |
| Images | `assets/img/` |

The name appears in the header and footer of each page, and in
`manifest.webmanifest`. Search-and-replace across the repo if you change it.

---

## Using it on the iPad

Open the site in Safari → Share → **Add to Home Screen**. It launches full screen
with no Safari chrome, which is the difference between looking like a website and
looking like an app.

Demos are cached by a service worker, so a demo you've opened once still runs if
the wifi dies mid-meeting. Worth doing deliberately: **open every demo you plan
to show while you're still on good wifi.** Then test one with Airplane Mode on.

---

## Layout

```
index.html  work.html  about.html  404.html
demos/
  index.html            the launcher — reads data/demos.json
  _template/            copy this to start a demo
  <client>-<slug>-<id>/ one folder per demo
assets/
  css/site.css          tokens, layout, components
  css/demo-shell.css    full-screen demo chrome + slide deck
  js/site.js            nav state, offline notice, SW registration
  js/launcher.js        renders the launcher grid
  js/deck.js            swipeable slide deck
  js/demo-shell.js      auto-hiding top bar
  img/
data/demos.json         the demo list
sw.js                   offline cache — BUMP VERSION ON EVERY CHANGE
manifest.webmanifest    Add-to-Home-Screen config
robots.txt              disallows /demos/
.nojekyll               stops Pages running Jekyll (needed for _template/)
```

## Previewing locally

No build step, but `fetch()` and the service worker need a real HTTP server —
opening `index.html` straight from disk leaves the launcher empty.

Easiest option, since you already have VS Code: install the **Live Preview**
extension (`ms-vscode.live-server`), then right-click `index.html` → *Show
Preview*. It serves the folder properly.

Honestly, though, pushing is fast enough that you can usually just deploy and
check the real URL — and that's the only way to test the service worker anyway,
since it needs HTTPS.

## Custom domain

When you buy one: add a `CNAME` file containing the bare domain, point four `A`
records at GitHub's Pages IPs (and `AAAA` records for IPv6), set the domain under
**Settings → Pages**, wait for the certificate, then tick **Enforce HTTPS**.
Update the absolute URLs in `robots.txt` and `sitemap.xml` at the same time.
