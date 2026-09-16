/* ==========================================================================
   launcher.js — renders the demo launcher from data/demos.json

   This is the page you actually open in front of a client, so it favours
   speed of finding the right demo: instant search, type filters, big targets.
   ========================================================================== */

(function () {
  "use strict";

  var TYPES = {
    app:  { label: "App",   hint: "Interactive" },
    deck: { label: "Deck",  hint: "Slides" },
    link: { label: "Link",  hint: "Opens externally" }
  };

  var grid = document.getElementById("demo-grid");
  var search = document.getElementById("demo-search");
  var chipBar = document.getElementById("demo-chips");
  if (!grid) return;

  var all = [];
  var activeType = "all";
  var query = "";

  /* --- Load ---------------------------------------------------------------- */

  fetch("../data/demos.json", { cache: "no-cache" })
    .then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then(function (data) {
      all = (data.demos || []).slice().sort(function (a, b) {
        return String(b.date || "").localeCompare(String(a.date || ""));
      });
      buildChips();
      render();
    })
    .catch(function (err) {
      grid.innerHTML = "";
      var p = document.createElement("p");
      p.className = "empty";
      p.textContent = "Could not load the demo list (" + err.message + ").";
      grid.appendChild(p);
    });

  /* --- Chips --------------------------------------------------------------- */

  function buildChips() {
    if (!chipBar) return;
    var present = ["all"].concat(
      Object.keys(TYPES).filter(function (t) {
        return all.some(function (d) { return d.type === t; });
      })
    );
    if (present.length <= 2) return;   // only one real type — chips add nothing

    present.forEach(function (t) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = t === "all" ? "All" : TYPES[t].label;
      b.setAttribute("aria-pressed", t === activeType ? "true" : "false");
      b.addEventListener("click", function () {
        activeType = t;
        Array.prototype.forEach.call(chipBar.children, function (c) {
          c.setAttribute("aria-pressed", c === b ? "true" : "false");
        });
        render();
      });
      chipBar.appendChild(b);
    });
  }

  /* --- Filter -------------------------------------------------------------- */

  function matches(d) {
    if (activeType !== "all" && d.type !== activeType) return false;
    if (!query) return true;
    var hay = [d.title, d.client, d.notes, d.type].join(" ").toLowerCase();
    return hay.indexOf(query) !== -1;
  }

  if (search) {
    search.addEventListener("input", function () {
      query = search.value.trim().toLowerCase();
      render();
    });
  }

  /* --- Render -------------------------------------------------------------- */

  function hrefFor(d) {
    return d.type === "link" ? d.url : "./" + d.slug + "/";
  }

  function card(d) {
    var li = document.createElement("li");
    li.className = "card";

    var a = document.createElement("a");
    a.className = "card__hit";
    a.href = hrefFor(d);

    // External demos open in a new tab rather than an iframe: most live apps
    // send X-Frame-Options or a frame-ancestors CSP that would blank an embed.
    if (d.type === "link") {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    }

    var media = document.createElement("div");
    media.className = "card__media";
    if (d.thumb) {
      var img = document.createElement("img");
      img.src = d.thumb;
      img.alt = "";
      img.loading = "lazy";
      media.appendChild(img);
    } else {
      var ph = document.createElement("span");
      ph.className = "placeholder";
      ph.textContent = (d.client || d.title || "?").charAt(0).toUpperCase();
      media.appendChild(ph);
    }

    var body = document.createElement("div");
    body.className = "card__body";

    var meta = document.createElement("p");
    meta.className = "card__meta";
    meta.textContent = [d.client, d.date].filter(Boolean).join(" · ");

    var h = document.createElement("h3");
    h.className = "card__title";
    h.textContent = d.title || d.slug;

    var badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = (TYPES[d.type] || {}).label || d.type || "Demo";
    h.append(" ", badge);

    body.append(meta, h);

    if (d.notes) {
      var p = document.createElement("p");
      p.className = "card__desc";
      p.textContent = d.notes;
      body.appendChild(p);
    }

    a.append(media, body);
    li.appendChild(a);
    return li;
  }

  function render() {
    var list = all.filter(matches);
    grid.innerHTML = "";

    if (!list.length) {
      var p = document.createElement("p");
      p.className = "empty";
      p.textContent = all.length
        ? "No demos match that."
        : "No demos yet. Add one to data/demos.json.";
      grid.appendChild(p);
      return;
    }

    var frag = document.createDocumentFragment();
    list.forEach(function (d) { frag.appendChild(card(d)); });
    grid.appendChild(frag);
  }
})();
