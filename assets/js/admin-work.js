/* ==========================================================================
   admin-work.js — the films on the work page

   A film goes up as it is: there is no way to re-encode video in a browser
   worth trusting, so what is chosen is what visitors download. The poster
   frame is the exception — if none is given, one is taken from the film
   itself, a second in.

   GitHub takes nothing over 100 MB, and anything over 50 MB is slow for
   visitors on a phone, so the size is checked before anything is uploaded.
   ========================================================================== */

(function () {
  "use strict";

  var A = window.SiteAdmin, F = window.AdminFormats.work, el = A.el;

  var MB = 1024 * 1024;
  var HARD_LIMIT = 95 * MB;     // GitHub's own ceiling is 100 MB, with the encoding on top
  var SOFT_LIMIT = 50 * MB;

  var listEl = document.getElementById("list");
  var countEl = document.getElementById("count");
  var loadingEl = document.getElementById("loading");
  var addForm = document.getElementById("add-form");
  var addMsg = document.getElementById("add-msg");
  var fileInput = document.getElementById("a-video");

  var items = [];
  var previews = {};       // poster path → a local picture, for films not live yet
  var taken = {};          // file names already handed out this session

  /* --- The list -------------------------------------------------------------- */

  function move(i, by) {
    var j = i + by;
    if (j < 0 || j >= items.length) return;
    var t = items[i]; items[i] = items[j]; items[j] = t;
    render();
    admin.changed();
  }

  function row(f, i) {
    var title = el("input", { type: "text", value: f.title });
    title.addEventListener("input", function () { f.title = title.value; admin.changed(); });

    var poster = f.poster
      ? el("img", { src: previews[f.poster] || f.poster, alt: "", loading: "lazy", decoding: "async" })
      : el("span", { className: "row__none", text: "No poster" });

    return el("li", { className: "row row--film" + (f._uploads ? " is-new" : "") }, [
      el("div", { className: "row__thumb row__thumb--wide" }, [poster]),
      el("div", { className: "row__fields" }, [
        el("label", { className: "field field--tight" }, [
          el("span", { className: "field__label", text: "Title" }), title
        ]),
        el("p", { className: "row__meta", text: f.src.replace(/^\/assets\/video\//, "") +
          (f._bytes ? " · " + Math.round(f._bytes / MB) + " MB, uploads when you publish" : "") })
      ]),
      el("div", { className: "row__actions" }, [
        el("button", { type: "button", className: "icon-btn", title: "Move up", text: "↑",
                       disabled: i === 0, on: { click: function () { move(i, -1); } } }),
        el("button", { type: "button", className: "icon-btn", title: "Move down", text: "↓",
                       disabled: i === items.length - 1, on: { click: function () { move(i, 1); } } }),
        el("button", { type: "button", className: "icon-btn icon-btn--remove", title: "Remove this film",
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
    items.forEach(function (f, i) { listEl.appendChild(row(f, i)); });
    countEl.textContent = items.length + (items.length === 1 ? " film" : " films");
  }

  /* --- Reading a film -------------------------------------------------------------
     Its shape, for the width and height the player is given, and a frame for
     the poster. iOS will only seek a video it has been told it may play
     inline and muted, and sometimes not even then, so the frame is a nicety:
     if it does not come within a few seconds the film goes up without one.
  -------------------------------------------------------------------------- */

  function inspect(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var v = document.createElement("video");
      var done = false;
      var finish = function (result) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        v.removeAttribute("src");
        v.load();
        URL.revokeObjectURL(url);
        resolve(result);
      };
      var timer = setTimeout(function () {
        finish({ w: v.videoWidth || 1280, h: v.videoHeight || 720, frame: null });
      }, 10000);

      v.muted = true;
      v.playsInline = true;
      v.setAttribute("playsinline", "");
      v.preload = "auto";
      v.addEventListener("loadedmetadata", function () {
        v.currentTime = Math.min(1, (v.duration || 2) / 3);
      });
      v.addEventListener("seeked", function () {
        var w = v.videoWidth, h = v.videoHeight;
        if (!w || !h) return finish({ w: 1280, h: 720, frame: null });
        var scale = Math.min(1, 1280 / Math.max(w, h));
        var c = document.createElement("canvas");
        c.width = Math.round(w * scale);
        c.height = Math.round(h * scale);
        try {
          c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
          c.toBlob(function (blob) { finish({ w: w, h: h, frame: blob }); }, "image/jpeg", 0.82);
        } catch (e) {
          finish({ w: w, h: h, frame: null });
        }
      });
      v.addEventListener("error", function () { finish({ w: 1280, h: 720, frame: null }); });
      v.src = url;
    });
  }

  function posterFrom(file) {
    // A chosen poster is resized like any other picture; 1280 matches the films.
    return A.twoSizes(file, 1280, 1280).then(function (out) { return out.full.blob; });
  }

  function freeName(title) {
    var base = A.slug(title), name = base, n = 2, files = admin.files();
    while (files["assets/video/" + name + ".mp4"] || files["assets/video/" + name + ".jpg"] || taken[name]) {
      name = base + "-" + n++;
    }
    taken[name] = true;
    return name;
  }

  fileInput.addEventListener("change", function () {
    var file = fileInput.files[0];
    if (!file) return A.message(addMsg, "");
    var mb = Math.round(file.size / MB);
    if (file.size > HARD_LIMIT) {
      A.message(addMsg, "That film is " + mb + " MB. GitHub will not take anything over 100 MB — " +
                "export a smaller copy (1080p H.264 is plenty) and choose that instead.", "error");
    } else if (file.size > SOFT_LIMIT) {
      A.message(addMsg, "That film is " + mb + " MB. It will work, but it is a long wait on a phone. " +
                "A smaller export would be kinder to visitors.");
    } else {
      A.message(addMsg, mb + " MB — fine.");
    }
  });

  addForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var file = fileInput.files[0];
    var posterFile = document.getElementById("a-poster").files[0];
    var title = document.getElementById("a-title").value.trim();
    if (!file) return A.message(addMsg, "Choose a film first.", "error");
    if (!title) return A.message(addMsg, "Give it a title.", "error");
    if (file.size > HARD_LIMIT) {
      return A.message(addMsg, "That film is over GitHub's 100 MB limit. Export a smaller copy first.", "error");
    }

    var btn = addForm.querySelector("button[type=submit]");
    btn.disabled = true;
    A.message(addMsg, "Reading the film…");

    inspect(file).then(function (info) {
      return (posterFile ? posterFrom(posterFile) : Promise.resolve(info.frame)).then(function (poster) {
        var name = freeName(title);
        var f = {
          src: "/assets/video/" + name + ".mp4",
          type: "video/mp4",
          poster: poster ? "/assets/video/" + name + ".jpg" : "",
          w: info.w,
          h: info.h,
          title: title,
          _bytes: file.size,
          _uploads: [{ path: "assets/video/" + name + ".mp4", blob: file, label: title }]
        };
        if (poster) {
          f._uploads.push({ path: "assets/video/" + name + ".jpg", blob: poster, label: title + " poster" });
          previews[f.poster] = URL.createObjectURL(poster);
        }

        if (document.getElementById("a-where").value === "first") items.unshift(f);
        else items.push(f);

        addForm.reset();
        render();
        admin.changed();
        A.message(addMsg, poster
          ? "Added. Press Publish to upload it — keep this page open until it says Published."
          : "Added, but no poster frame could be taken from it, so it will show black until played. " +
            "Remove it and add it again with a poster image if that matters.", poster ? "done" : null);
      });
    }).catch(function (err) {
      A.message(addMsg, err.message, "error");
    }).then(function () { btn.disabled = false; });
  });

  /* --- Wiring -------------------------------------------------------------------- */

  var admin = A.boot({
    page: "work.html",

    loading: function (on) { loadingEl.hidden = !on; },

    loaded: function (html) {
      items = F.parse(html);
      taken = {};
      render();
    },

    dirty: function (html) { return F.render(html, items) !== html; },

    build: function (html) {
      var uploads = [], used = {};
      items.forEach(function (f) {
        if (f._uploads) uploads = uploads.concat(f._uploads);
        used[f.src] = used[f.poster] = true;
      });

      // A removed film's files go too — unlike the catalogue's pictures,
      // nothing else on the site points at them.
      var gone = F.parse(html).filter(function (f) { return !used[f.src]; });
      var remove = [];
      gone.forEach(function (f) {
        remove.push(f.src.replace(/^\//, ""));
        if (f.poster && !used[f.poster]) remove.push(f.poster.replace(/^\//, ""));
      });

      var bits = [];
      var added = items.filter(function (f) { return f._uploads; }).map(function (f) { return f.title; });
      if (added.length) bits.push("add " + added.join(", "));
      if (gone.length) bits.push("remove " + gone.map(function (f) { return f.title; }).join(", "));
      var head = bits.length ? "Work: " + bits.join("; ") : "Work: edit the films";
      if (head.length > 72) head = head.slice(0, 69) + "…";

      return {
        html: F.render(html, items),
        uploads: uploads,
        remove: remove,
        message: head + "\n\nFrom the admin panel's work page editor."
      };
    }
  });
})();
