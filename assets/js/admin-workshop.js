/* ==========================================================================
   admin-workshop.js — the workshop photographs, in albums

   An album is a titled group on the workshop page. The first one can go
   without a title, which is how the photographs that were there before albums
   existed are kept: one untitled album, looking exactly as the page always
   did, until something is added around it.

   An album with no photographs is kept but hidden, so it can be made first
   and filled after. Deleting an album deletes the photographs in it.
   ========================================================================== */

(function () {
  "use strict";

  var A = window.SiteAdmin, F = window.AdminFormats.workshop, el = A.el;

  var albumsEl = document.getElementById("albums");
  var countEl = document.getElementById("count");
  var loadingEl = document.getElementById("loading");
  var newForm = document.getElementById("new-album");
  var msgEl = document.getElementById("add-msg");

  var albums = [];
  var previews = {};       // thumbnail path → a local picture, for photographs not live yet
  var nextNum = 0;
  var busy = false;

  function total() {
    return albums.reduce(function (n, a) { return n + a.photos.length; }, 0);
  }

  function name(a, i) { return a.title || (i === 0 ? "Untitled album" : "Untitled album " + (i + 1)); }

  /* --- Adding photographs ------------------------------------------------------ */

  function addPhotos(album, files) {
    if (busy || !files.length) return;
    busy = true;
    var list = Array.prototype.slice.call(files);
    var added = 0;

    var chain = Promise.resolve();
    list.forEach(function (file, k) {
      chain = chain.then(function () {
        A.message(msgEl, "Resizing photograph " + (k + 1) + " of " + list.length + "…");
        return A.twoSizes(file, 1800, 600);
      }).then(function (out) {
        nextNum = Math.max(nextNum, A.nextNumber(admin.files(), "assets/img/workshop"));
        var n = A.pad2(nextNum++);
        var s = {
          full: "/assets/img/workshop/full/" + n + ".jpg",
          src: "/assets/img/workshop/" + n + ".jpg",
          alt: "Calligraphy workshop",
          w: out.thumb.w,
          h: out.thumb.h,
          _uploads: [
            { path: "assets/img/workshop/full/" + n + ".jpg", blob: out.full.blob, label: "photograph " + n + " (large)" },
            { path: "assets/img/workshop/" + n + ".jpg", blob: out.thumb.blob, label: "photograph " + n }
          ]
        };
        previews[s.src] = URL.createObjectURL(out.thumb.blob);
        album.photos.push(s);
        added++;
      }).catch(function (err) {
        A.message(msgEl, err.message, "error");
      });
    });

    return chain.then(function () {
      busy = false;
      render();
      admin.changed();
      if (added) {
        A.message(msgEl, added + (added === 1 ? " photograph" : " photographs") + " added to " +
                  name(album, albums.indexOf(album)) + ". Press Publish to put them on the site.", "done");
      }
    });
  }

  /* --- Drawing it ------------------------------------------------------------------ */

  function moveAlbum(i, by) {
    var j = i + by;
    if (j < 0 || j >= albums.length) return;
    var t = albums[i]; albums[i] = albums[j]; albums[j] = t;
    render();
    admin.changed();
  }

  function tile(album, ai, s, si) {
    var where = el("select", { title: "Move to another album" });
    albums.forEach(function (a, i) {
      where.appendChild(el("option", { value: String(i), text: name(a, i), selected: i === ai }));
    });
    where.addEventListener("change", function () {
      var to = albums[Number(where.value)];
      album.photos.splice(si, 1);
      to.photos.push(s);
      render();
      admin.changed();
    });

    return el("li", { className: "tile" + (s._uploads ? " is-new" : "") }, [
      el("img", { src: previews[s.src] || s.src, alt: "", loading: "lazy", decoding: "async" }),
      el("div", { className: "tile__bar" }, [
        albums.length > 1 ? where : null,
        el("button", { type: "button", className: "tile__remove", title: "Remove this photograph",
                       "aria-label": "Remove this photograph", text: "×",
                       on: { click: function () {
                         album.photos.splice(si, 1);
                         render();
                         admin.changed();
                       } } })
      ])
    ]);
  }

  function block(a, i) {
    var title = el("input", { type: "text", value: a.title,
                              placeholder: "No title — shown without a heading" });
    title.addEventListener("input", function () { a.title = title.value.trim(); admin.changed(); });

    var picker = el("input", { type: "file", accept: "image/*", multiple: true });
    picker.addEventListener("change", function () {
      addPhotos(a, picker.files);
      picker.value = "";
    });

    var grid = el("ul", { className: "tiles" });
    a.photos.forEach(function (s, si) { grid.appendChild(tile(a, i, s, si)); });

    return el("section", { className: "album-block" }, [
      el("div", { className: "album-block__head" }, [
        el("label", { className: "field field--tight album-block__title" }, [
          el("span", { className: "field__label",
                       text: "Album " + (i + 1) + " · " + a.photos.length +
                             (a.photos.length === 1 ? " photograph" : " photographs") +
                             (a.photos.length ? "" : " · hidden until it has one") }),
          title
        ]),
        el("div", { className: "row__actions" }, [
          el("button", { type: "button", className: "icon-btn", title: "Move album up", text: "↑",
                         disabled: i === 0, on: { click: function () { moveAlbum(i, -1); } } }),
          el("button", { type: "button", className: "icon-btn", title: "Move album down", text: "↓",
                         disabled: i === albums.length - 1, on: { click: function () { moveAlbum(i, 1); } } }),
          el("button", { type: "button", className: "icon-btn icon-btn--remove", text: "Delete album",
                         on: { click: function () {
                           if (a.photos.length && !confirm("Delete " + name(a, i) + " and the " +
                               a.photos.length + " photographs in it?")) return;
                           albums.splice(i, 1);
                           render();
                           admin.changed();
                         } } })
        ])
      ]),
      a.photos.length ? grid : null,
      el("label", { className: "upload upload--small" }, [
        el("span", { className: "upload__label", text: "Add photographs to this album" }), picker
      ])
    ]);
  }

  function render() {
    albumsEl.textContent = "";
    albums.forEach(function (a, i) { albumsEl.appendChild(block(a, i)); });
    var n = total();
    countEl.textContent = albums.length + (albums.length === 1 ? " album, " : " albums, ") +
      n + (n === 1 ? " photograph" : " photographs");
  }

  newForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var input = document.getElementById("n-title");
    var t = input.value.trim();
    if (!t) return A.message(msgEl, "Give the album a title.", "error");
    var a = { title: t, photos: [] };
    if (document.getElementById("n-where").value === "first") albums.unshift(a);
    else albums.push(a);
    input.value = "";
    render();
    admin.changed();
    A.message(msgEl, "Album made. Add photographs to it below — it stays hidden on the site until it has one.", "done");
  });

  /* --- Wiring -------------------------------------------------------------------- */

  var admin = A.boot({
    page: "workshop.html",

    loading: function (on) { loadingEl.hidden = !on; },

    loaded: function (html) {
      albums = F.parse(html);
      render();
    },

    dirty: function (html) { return F.render(html, albums) !== html; },

    build: function (html) {
      if (busy) throw new Error("wait for the photographs to finish resizing first.");
      var uploads = [], used = {};
      albums.forEach(function (a) {
        a.photos.forEach(function (s) {
          if (s._uploads) uploads = uploads.concat(s._uploads);
          used[s.src] = used[s.full] = true;
        });
      });

      // Removed photographs take their files with them; nothing else uses them.
      var remove = [], gone = 0;
      F.parse(html).forEach(function (a) {
        a.photos.forEach(function (s) {
          if (used[s.src]) return;
          gone++;
          remove.push(s.src.replace(/^\//, ""));
          if (!used[s.full]) remove.push(s.full.replace(/^\//, ""));
        });
      });

      var added = uploads.length / 2;
      var bits = [];
      if (added) bits.push("add " + added + (added === 1 ? " photograph" : " photographs"));
      if (gone) bits.push("remove " + gone);
      var head = "Workshop: " + (bits.length ? bits.join(", ") : "edit the albums");

      return {
        html: F.render(html, albums),
        uploads: uploads,
        remove: remove,
        message: head + "\n\nFrom the admin panel's workshop page editor."
      };
    }
  });
})();
