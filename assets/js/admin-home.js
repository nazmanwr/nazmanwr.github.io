/* ==========================================================================
   admin-home.js — the catalogue on the home page

   Add a listing, take one down, change its words, mark it sold, move it up or
   down. Nothing leaves this page until Publish; until then Discard puts it
   all back.

   Taking a listing down removes it from the page but leaves its image files
   where they are. An auction — past or running — may point at the same
   picture, and a lot that loses its photograph mid-auction is not a risk worth
   a few hundred kilobytes.
   ========================================================================== */

(function () {
  "use strict";

  var A = window.SiteAdmin, F = window.AdminFormats.home, el = A.el;

  var listEl = document.getElementById("list");
  var countEl = document.getElementById("count");
  var loadingEl = document.getElementById("loading");
  var addForm = document.getElementById("add-form");
  var addMsg = document.getElementById("add-msg");

  var items = [];          // what the page will hold
  var original = {};       // src → the item's markup as loaded, to name what changed
  var previews = {};       // src → a local picture, for listings not live yet
  var nextNum = 0;

  function money(v) {
    var s = String(v).trim();
    if (/^\d[\d,]*$/.test(s)) return "BDT " + Number(s.replace(/,/g, "")).toLocaleString("en-US");
    return s;
  }

  /* --- The list -------------------------------------------------------------- */

  function field(label, value, onInput, opts) {
    opts = opts || {};
    var input = el("input", { type: "text", value: value || "", placeholder: opts.placeholder || "" });
    input.addEventListener("input", function () { onInput(input.value); admin.changed(); });
    if (opts.onBlur) input.addEventListener("blur", function () { opts.onBlur(input); });
    return el("label", { className: "field field--tight" }, [
      el("span", { className: "field__label", text: label }), input
    ]);
  }

  function move(i, by) {
    var j = i + by;
    if (j < 0 || j >= items.length) return;
    var t = items[i]; items[i] = items[j]; items[j] = t;
    render();
    admin.changed();
  }

  function row(p, i) {
    var sold = el("input", { type: "checkbox", checked: p.sold });
    sold.addEventListener("change", function () { p.sold = sold.checked; admin.changed(); });

    return el("li", { className: "row" + (p._uploads ? " is-new" : "") }, [
      el("div", { className: "row__thumb" }, [
        el("img", { src: previews[p.src] || p.src, alt: "", loading: "lazy", decoding: "async" })
      ]),
      el("div", { className: "row__fields" }, [
        field("Title", p.title, function (v) {
          if (p.alt === p.title) p.alt = v;     // the alt text follows a title it matched
          p.title = v;
        }),
        el("div", { className: "field-row field-row--tight" }, [
          field("Size", p.size, function (v) { p.size = v; }, { placeholder: "20” × 13”" }),
          field("Price", p.price, function (v) { p.price = v; }, {
            placeholder: "BDT 20,000",
            onBlur: function (input) { input.value = p.price = money(input.value); admin.changed(); }
          })
        ]),
        field("Note under the price", p.note, function (v) { p.note = v; },
              { placeholder: "Excluding installation" }),
        el("label", { className: "check" }, [sold, el("span", { text: "Sold" })])
      ]),
      el("div", { className: "row__actions" }, [
        el("button", { type: "button", className: "icon-btn", title: "Move up", text: "↑",
                       disabled: i === 0, on: { click: function () { move(i, -1); } } }),
        el("button", { type: "button", className: "icon-btn", title: "Move down", text: "↓",
                       disabled: i === items.length - 1, on: { click: function () { move(i, 1); } } }),
        el("button", { type: "button", className: "icon-btn icon-btn--remove", title: "Take this listing down",
                       text: "Remove", on: { click: function () {
                         items.splice(i, 1);
                         render();
                         admin.changed();
                       } } })
      ])
    ]);
  }

  function render() {
    listEl.textContent = "";
    items.forEach(function (p, i) { listEl.appendChild(row(p, i)); });
    countEl.textContent = items.length + (items.length === 1 ? " listing" : " listings");
  }

  /* --- Adding one ---------------------------------------------------------------- */

  addForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var file = document.getElementById("a-photo").files[0];
    var title = document.getElementById("a-title").value.trim();
    if (!file) return A.message(addMsg, "Choose a photograph first.", "error");
    if (!title) return A.message(addMsg, "Give it a title.", "error");

    var btn = addForm.querySelector("button[type=submit]");
    btn.disabled = true;
    A.message(addMsg, "Resizing the photograph…");

    // Same sizes as the files already there: 1800 px for the viewer, 600 for the grid.
    A.twoSizes(file, 1800, 600).then(function (out) {
      nextNum = Math.max(nextNum, A.nextNumber(admin.files(), "assets/img/art"));
      var n = A.pad2(nextNum++);
      var p = {
        full: "/assets/img/art/full/" + n + ".jpg",
        src: "/assets/img/art/" + n + ".jpg",
        alt: title,
        w: out.thumb.w,
        h: out.thumb.h,
        title: title,
        size: document.getElementById("a-size").value.trim(),
        price: money(document.getElementById("a-price").value),
        note: document.getElementById("a-note").value.trim(),
        sold: false,
        _uploads: [
          { path: "assets/img/art/full/" + n + ".jpg", blob: out.full.blob, label: title + " (large)" },
          { path: "assets/img/art/" + n + ".jpg", blob: out.thumb.blob, label: title }
        ]
      };
      previews[p.src] = URL.createObjectURL(out.thumb.blob);

      if (document.getElementById("a-where").value === "first") items.unshift(p);
      else items.push(p);

      addForm.reset();
      render();
      admin.changed();
      A.message(addMsg, "Added. Press Publish to put it on the site.", "done");
    }).catch(function (err) {
      A.message(addMsg, err.message, "error");
    }).then(function () { btn.disabled = false; });
  });

  /* --- Wiring -------------------------------------------------------------------- */

  function describe(html) {
    var added = [], edited = [], kept = {};
    items.forEach(function (p, i) {
      kept[p.src] = true;
      if (p._uploads) added.push(p.title);
      else if (original[p.src] !== undefined && F.renderItem(p, 0) !== original[p.src]) edited.push(p.title);
    });
    var removed = F.parse(html).filter(function (p) { return !kept[p.src]; })
      .map(function (p) { return p.title; });

    var bits = [];
    if (added.length) bits.push("add " + added.join(", "));
    if (removed.length) bits.push("take down " + removed.join(", "));
    if (edited.length) bits.push("edit " + edited.join(", "));
    var head = bits.length ? "Catalogue: " + bits.join("; ") : "Catalogue: reorder the listings";
    if (head.length > 72) head = head.slice(0, 69) + "…";
    return head + "\n\nFrom the admin panel's home page editor.";
  }

  var admin = A.boot({
    page: "index.html",

    loading: function (on) { loadingEl.hidden = !on; },

    loaded: function (html) {
      items = F.parse(html);
      original = {};
      items.forEach(function (p) { original[p.src] = F.renderItem(p, 0); });
      render();
    },

    dirty: function (html) { return F.render(html, items) !== html; },

    build: function (html) {
      var uploads = [];
      items.forEach(function (p) { if (p._uploads) uploads = uploads.concat(p._uploads); });
      return { html: F.render(html, items), uploads: uploads, remove: [], message: describe(html) };
    }
  });
})();
