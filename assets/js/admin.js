/* ==========================================================================
   admin.js — putting an artwork up for auction

   In preview mode a published auction is written to this browser's local
   storage, and the auction page reads it from there. That makes the whole
   round trip walkable — fill the form, publish, open the auction page, bid —
   before any backend exists. Nothing leaves the machine.

   When Supabase is connected, publish() becomes one insert against the
   auctions table and everything above it stays as it is.
   ========================================================================== */

(function () {
  "use strict";

  var STORE_KEY = "auction:preview";
  var CATALOGUE_COUNT = 51;   // /assets/img/art/full/01.jpg … 51.jpg

  var f = {
    form: document.getElementById("auction-form"),
    picker: document.getElementById("picker"),
    title: document.getElementById("f-title"),
    medium: document.getElementById("f-medium"),
    size: document.getElementById("f-size"),
    start: document.getElementById("f-start"),
    raise: document.getElementById("f-raise"),
    starts: document.getElementById("f-starts"),
    ends: document.getElementById("f-ends"),
    msg: document.getElementById("admin-msg"),
    duration: document.getElementById("duration-note"),
    upload: document.getElementById("f-upload"),
    uploadNote: document.getElementById("upload-note")
  };

  var p = {
    image: document.getElementById("p-image"),
    empty: document.getElementById("p-empty"),
    title: document.getElementById("p-title"),
    spec: document.getElementById("p-spec"),
    start: document.getElementById("p-start"),
    raise: document.getElementById("p-raise")
  };

  var chosen = null;

  function taka(n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return "—";
    return "BDT " + v.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }

  function pad(n) { return n < 10 ? "0" + n : String(n); }

  // <input type="datetime-local"> wants local wall-clock time with no zone,
  // so it cannot be fed an ISO string straight from toISOString().
  function toLocalInput(d) {
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) +
           "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }

  /* --- Artwork picker ------------------------------------------------------- */

  function buildPicker() {
    for (var i = 1; i <= CATALOGUE_COUNT; i++) {
      var n = pad(i);
      var b = document.createElement("button");
      b.type = "button";
      b.className = "picker__item";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", "false");
      b.dataset.path = "/assets/img/art/full/" + n + ".jpg";

      var img = document.createElement("img");
      img.src = "/assets/img/art/" + n + ".jpg";   // the small one, for speed
      img.alt = "Artwork " + i;
      img.loading = "lazy";
      img.decoding = "async";

      b.appendChild(img);
      b.addEventListener("click", pick);
      f.picker.appendChild(b);
    }
  }

  function clearPicked() {
    Array.prototype.forEach.call(f.picker.children, function (c) {
      c.setAttribute("aria-checked", "false");
    });
  }

  function pick(e) {
    var btn = e.currentTarget;
    clearPicked();
    btn.setAttribute("aria-checked", "true");
    if (f.upload) f.upload.value = "";     // picking from the catalogue drops an upload
    chosen = btn.dataset.path;
    renderPreview();
  }

  /* --- Uploading a new photograph -------------------------------------------
     Resized here, in the browser, before it is stored or sent. A phone photo is
     4000px and several megabytes; nobody bidding needs that, and on a Dhaka
     mobile connection it would be the slowest thing on the page.
  -------------------------------------------------------------------------- */

  var MAX_EDGE = 1800;      // same as the catalogue's full-size images
  var JPEG_QUALITY = 0.82;

  function drawToJpeg(source, w, h) {
    var scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * scale));
    var ch = Math.max(1, Math.round(h * scale));
    var canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    var ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, cw, ch);
    return { url: canvas.toDataURL("image/jpeg", JPEG_QUALITY), w: cw, h: ch };
  }

  function shrinkViaImage(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(url);
        resolve(drawToJpeg(img, img.naturalWidth, img.naturalHeight));
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("that file could not be read as an image"));
      };
      img.src = url;
    });
  }

  // createImageBitmap honours the EXIF rotation a phone writes, so it is worth
  // preferring — without it a portrait photo can arrive on its side.
  //
  // But it can also sit there and never settle, resolving nothing and throwing
  // nothing, which leaves the upload stuck on "Resizing…" with no way out. So
  // it is raced against a timer, and anything other than a prompt success falls
  // through to the <img> path, which every browser handles.
  function shrink(file) {
    if (!window.createImageBitmap) return shrinkViaImage(file);

    return new Promise(function (resolve, reject) {
      var settled = false;

      var fallback = function () {
        if (settled) return;
        settled = true;
        shrinkViaImage(file).then(resolve, reject);
      };

      var timer = setTimeout(fallback, 4000);

      createImageBitmap(file, { imageOrientation: "from-image" }).then(function (bmp) {
        if (settled) { bmp.close(); return; }
        settled = true;
        clearTimeout(timer);
        var out = drawToJpeg(bmp, bmp.width, bmp.height);
        bmp.close();
        resolve(out);
      }).catch(function () {
        clearTimeout(timer);
        fallback();
      });
    });
  }

  function onUpload(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;

    if (!/^image\//.test(file.type)) {
      say("That is not an image file.", "error");
      return;
    }

    f.uploadNote.textContent = "Resizing…";

    shrink(file).then(function (out) {
      clearPicked();
      chosen = out.url;
      var kb = Math.round((out.url.length * 3 / 4) / 1024);
      f.uploadNote.textContent =
        file.name + " — " + out.w + "×" + out.h + ", about " + kb + " KB after resizing.";
      say("");
      renderPreview();
    }).catch(function (err) {
      f.uploadNote.textContent = "";
      say("Could not use that image: " + err.message, "error");
    });
  }

  /* --- Live preview --------------------------------------------------------- */

  function renderPreview() {
    if (chosen) {
      p.image.src = chosen;
      p.image.alt = f.title.value || "";
      p.image.hidden = false;
      if (p.empty) p.empty.hidden = true;
    } else {
      // An empty src makes the browser re-request the page itself.
      p.image.removeAttribute("src");
      p.image.hidden = true;
      if (p.empty) p.empty.hidden = false;
    }

    p.title.textContent = f.title.value || "Untitled";
    p.spec.textContent = [f.medium.value, f.size.value].filter(Boolean).join(" · ");
    p.start.textContent = taka(f.start.value);
    p.raise.textContent = f.raise.value
      ? "Raises of at least " + taka(f.raise.value)
      : "";
    renderDuration();
  }

  function renderDuration() {
    if (!f.starts.value || !f.ends.value) { f.duration.textContent = ""; return; }
    var a = new Date(f.starts.value), b = new Date(f.ends.value);
    var mins = Math.round((b - a) / 60000);
    if (!isFinite(mins) || mins <= 0) {
      f.duration.textContent = "The close needs to be after the opening.";
      return;
    }
    var days = Math.floor(mins / 1440);
    var hours = Math.floor((mins % 1440) / 60);
    f.duration.textContent = "Runs for " +
      (days ? days + (days === 1 ? " day " : " days ") : "") +
      (hours ? hours + (hours === 1 ? " hour" : " hours") : "") +
      " before any extension.";
  }

  /* --- Publishing ------------------------------------------------------------ */

  function say(text, kind) {
    f.msg.textContent = text;
    f.msg.className = "admin__msg" + (kind ? " is-" + kind : "");
  }

  function publish(e) {
    e.preventDefault();

    if (!chosen) { say("Choose an artwork first.", "error"); return; }

    var start = Number(f.start.value);
    var raise = Number(f.raise.value);
    var opens = new Date(f.starts.value);
    var closes = new Date(f.ends.value);

    if (!(start > 0)) { say("Set a starting bid.", "error"); return; }
    if (!(raise > 0)) { say("Set a lowest bid.", "error"); return; }
    if (!(closes > opens)) { say("The close has to be after the opening.", "error"); return; }

    var auction = {
      id: "preview-" + Date.now(),
      title: f.title.value || "Untitled",
      medium: f.medium.value,
      size: f.size.value,
      image_path: chosen,
      start_price: start,
      increment: raise,
      status: closes > new Date() ? "live" : "closed",
      starts_at: opens.toISOString(),
      ends_at: closes.toISOString(),
      scheduled_end_at: closes.toISOString()
    };

    try {
      // A new lot starts with no bids — never inherit the last one's.
      localStorage.setItem(STORE_KEY, JSON.stringify({ auction: auction, bids: [] }));
    } catch (err) {
      say(err && err.name === "QuotaExceededError"
        ? "The preview store is full — this only limits the preview, not the real thing. Clear it by publishing a catalogue artwork instead."
        : "This browser would not save the preview (" + (err && err.name) + ").", "error");
      return;
    }

    say("Published. Open the auction page to see it.", "done");

    var link = document.createElement("a");
    link.href = "/auction.html";
    link.textContent = "Go to the auction page →";
    link.style.display = "inline-block";
    link.style.marginTop = "0.5rem";
    f.msg.appendChild(document.createElement("br"));
    f.msg.appendChild(link);
  }

  /* --- The gate --------------------------------------------------------------
     On a static host the page itself cannot be hidden, so it is not the page
     that is protected — it is the database. Signed out, this shows a sign-in
     box and nothing else; signed in as anyone other than the owner, the
     database refuses to create an auction anyway.

     ?signedout=1 shows the sign-in screen while still in preview.
  -------------------------------------------------------------------------- */

  function showGate(on) {
    var gate = document.getElementById("gate");
    var flag = document.getElementById("preview-flag");
    var aside = document.querySelector(".admin__preview");
    if (gate) gate.hidden = !on;
    if (f.form) f.form.hidden = on;
    if (aside) aside.hidden = on;
    if (flag) flag.hidden = on;
  }

  var pretendSignedOut = /[?&]signedout=1/.test(location.search);

  if (pretendSignedOut) {
    showGate(true);
    var gform = document.getElementById("gate-form");
    if (gform) {
      gform.addEventListener("submit", function (e) {
        e.preventDefault();
        var m = document.getElementById("gate-msg");
        m.className = "admin__msg is-done";
        m.textContent = "In the live version a sign-in link would be on its way to " +
          (document.getElementById("gate-email").value || "your email") +
          ". This is the preview, so nothing was sent.";
      });
    }
    return;     // nothing below matters while the gate is up
  }

  /* --- Go -------------------------------------------------------------------- */

  buildPicker();

  // Sensible defaults: opens now, closes in three days.
  var now = new Date();
  var later = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  f.starts.value = toLocalInput(now);
  f.ends.value = toLocalInput(later);

  ["title", "medium", "size", "start", "raise", "starts", "ends"].forEach(function (k) {
    f[k].addEventListener("input", renderPreview);
  });

  if (f.upload) f.upload.addEventListener("change", onUpload);

  f.form.addEventListener("submit", publish);

  renderPreview();
})();
