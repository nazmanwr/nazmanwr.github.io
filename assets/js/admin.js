/* ==========================================================================
   admin.js — putting an artwork up for auction

   This writes a real auction. Filling the form and pressing publish inserts
   one row in Supabase, and from that moment the auction page and the strip on
   the home page show it to everyone.

   Two things stand between this page and the database, and neither of them is
   the page itself — it is public, as any file on a static host must be:

     1. Signed out, nothing here can talk to the database at all.
     2. Signed in as anybody other than the owner, the database refuses the
        insert. That rule lives in owner.sql, not in this file, so it cannot be
        edited away from a browser.
   ========================================================================== */

(function () {
  "use strict";

  var CATALOGUE_COUNT = 51;   // /assets/img/art/full/01.jpg … 51.jpg
  var BUCKET = "auction";     // where uploaded photographs go

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

  var chosen = null;      // what the preview shows
  var pending = null;     // an uploaded photograph, waiting to be sent

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
    pending = null;
    chosen = btn.dataset.path;
    renderPreview();
  }

  /* --- Uploading a new photograph -------------------------------------------
     Resized here, in the browser, before it is sent. A phone photo is 4000px
     and several megabytes; nobody bidding needs that, and on a Dhaka mobile
     connection it would be the slowest thing on the page.
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

    return new Promise(function (resolve) {
      var done = function (blob) {
        resolve({
          blob: blob,
          url: URL.createObjectURL(blob),
          bytes: blob.size,
          w: cw,
          h: ch
        });
      };
      // toBlob is the one that gives something uploadable. Where it is missing,
      // go the long way round through the data URL.
      if (canvas.toBlob) {
        canvas.toBlob(function (blob) { done(blob); }, "image/jpeg", JPEG_QUALITY);
      } else {
        var url = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
        var bin = atob(url.split(",")[1]);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        done(new Blob([bytes], { type: "image/jpeg" }));
      }
    });
  }

  function shrinkViaImage(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(url);
        drawToJpeg(img, img.naturalWidth, img.naturalHeight).then(resolve, reject);
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
        drawToJpeg(bmp, bmp.width, bmp.height).then(function (out) {
          bmp.close();
          resolve(out);
        }, reject);
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
      pending = out;
      chosen = out.url;
      f.uploadNote.textContent = file.name + " — " + out.w + "×" + out.h +
        ", about " + Math.round(out.bytes / 1024) + " KB after resizing.";
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

  function busy(on) {
    var btn = document.getElementById("publish");
    if (btn) btn.disabled = on;
  }

  // A catalogue artwork already has a URL on this site. An uploaded photograph
  // has to be put somewhere first, and that somewhere is the auction bucket.
  function imageURL(db) {
    if (!pending) return Promise.resolve(chosen);

    var name = "lot-" + Date.now() + ".jpg";
    return db.storage.from(BUCKET)
      .upload(name, pending.blob, { contentType: "image/jpeg", upsert: false })
      .then(function (r) {
        if (r.error) throw new Error("the photograph would not upload — " + r.error.message);
        return db.storage.from(BUCKET).getPublicUrl(name).data.publicUrl;
      });
  }

  function publish(e) {
    e.preventDefault();

    var db = window.AUCTION_DB;
    if (!db) { say("Not connected to the database — reload the page.", "error"); return; }
    if (!chosen) { say("Choose an artwork first.", "error"); return; }

    var start = Number(f.start.value);
    var raise = Number(f.raise.value);
    var opens = new Date(f.starts.value);
    var closes = new Date(f.ends.value);

    if (!(start > 0)) { say("Set a starting bid.", "error"); return; }
    if (!(raise > 0)) { say("Set a lowest bid.", "error"); return; }
    if (!(closes > opens)) { say("The close has to be after the opening.", "error"); return; }

    busy(true);
    say(pending ? "Uploading the photograph…" : "Publishing…");

    imageURL(db).then(function (path) {
      say("Publishing…");
      return db.from("auctions").insert({
        title: f.title.value || "Untitled",
        medium: f.medium.value || null,
        size: f.size.value || null,
        image_path: path,
        start_price: start,
        increment: raise,
        status: opens <= new Date() ? "live" : "scheduled",
        starts_at: opens.toISOString(),
        ends_at: closes.toISOString(),
        scheduled_end_at: closes.toISOString()
      }).select("id").single();
    }).then(function (r) {
      if (r.error) {
        // The commonest refusal by far: signed in, but not as the owner.
        throw new Error(/row-level security/i.test(r.error.message)
          ? "the database would not accept it from this account. Sign in as nazm.anwr@gmail.com."
          : r.error.message);
      }

      busy(false);
      say("Published. It is on the auction page and the home page now.", "done");

      var link = document.createElement("a");
      link.href = "/auction.html";
      link.textContent = "Go to the auction page →";
      link.style.display = "inline-block";
      link.style.marginTop = "0.5rem";
      f.msg.appendChild(document.createElement("br"));
      f.msg.appendChild(link);
    }).catch(function (err) {
      busy(false);
      say("Not published — " + (err && err.message ? err.message : "something went wrong."), "error");
    });
  }

  /* --- The gate --------------------------------------------------------------
     Signed out, this shows a sign-in box and nothing else. The link that comes
     by email brings you back to this page already signed in, and it stays that
     way on that device, so it is once per phone or iPad.

     ?signedout=1 shows the sign-in screen even when already signed in, which is
     how to check what it looks like.
  -------------------------------------------------------------------------- */

  function showGate(on) {
    var gate = document.getElementById("gate");
    var aside = document.querySelector(".admin__preview");
    if (gate) gate.hidden = !on;
    if (f.form) f.form.hidden = on;
    if (aside) aside.hidden = on;
  }

  function wireGate() {
    var gform = document.getElementById("gate-form");
    var m = document.getElementById("gate-msg");
    if (!gform) return;

    gform.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = document.getElementById("gate-email").value.trim();
      if (!email) return;

      m.className = "admin__msg";
      m.textContent = "Sending…";

      window.AUCTION_SOURCE.signIn(email).then(function () {
        m.className = "admin__msg is-done";
        m.textContent = "Check " + email + " — the link signs you in on this device.";
      }).catch(function (err) {
        m.className = "admin__msg is-error";
        m.textContent = "Could not send it: " + (err && err.message);
      });
    });
  }

  /* --- Handing the parcel to Steadfast ---------------------------------------
     Every field shown here is fetched from the database, not held in the page:
     the winner's phone and address are unreadable to the publishable key by
     design, so dispatch_details() hands over exactly this one winner's, and
     only to the signed-in owner.

     Nothing about the courier's keys passes through the browser either. The
     page asks the database to make the call; the database holds the keys.
  -------------------------------------------------------------------------- */

  var d = {
    panel: document.getElementById("dispatch"),
    lot:   document.getElementById("d-lot"),
    who:   document.getElementById("d-who"),
    zone:  document.getElementById("d-zone"),
    cod:   document.getElementById("d-cod"),
    note:  document.getElementById("d-note"),
    send:  document.getElementById("d-send"),
    msg:   document.getElementById("d-msg")
  };

  var dispatchId = null;
  var winningBid = 0;

  function dSay(text, kind) {
    d.msg.textContent = text || "";
    d.msg.className = "admin__msg" + (kind ? " is-" + kind : "");
  }

  function pair(term, value, missing) {
    var dt = document.createElement("dt");
    dt.textContent = term;
    var dd = document.createElement("dd");
    dd.textContent = value || "not recorded — ask them";
    if (!value || missing) dd.className = "is-missing";
    d.who.append(dt, dd);
  }

  function recomputeCod() {
    d.cod.value = String(winningBid + Number(d.zone.value || 0));
  }

  function showSent(consignment, tracking) {
    d.send.hidden = true;
    var box = document.createElement("p");
    box.className = "tracking";
    box.innerHTML = "Consignment <strong>" + (consignment || "—") +
                    "</strong> · tracking <strong>" + (tracking || "—") + "</strong>";
    d.msg.after(box);
  }

  // Shown only when something actually went wrong. A panel that stays hidden
  // on failure is indistinguishable from one that was never deployed.
  function dispatchTrouble(message) {
    d.panel.hidden = false;
    d.lot.textContent = "";
    d.who.innerHTML = "";
    d.zone.closest(".field-row").hidden = true;
    d.note.closest(".field").hidden = true;
    d.send.hidden = true;
    dSay(message, "error");
  }

  function loadDispatch(db) {
    return db.rpc("latest_dispatchable").then(function (r) {
      if (r.error) throw new Error(r.error.message);
      if (!r.data) return;                       // nothing closed yet
      dispatchId = r.data;
      return db.rpc("dispatch_details", { p_auction_id: dispatchId });
    }).then(function (r) {
      if (!r) return;
      if (r.error) throw new Error(r.error.message);
      if (!r.data || !r.data.length) return;

      var w = r.data[0];
      winningBid = Number(w.amount);

      d.lot.textContent = w.title + (w.spec ? " — " + w.spec : "") +
                          " · won at " + taka(w.amount);

      d.who.innerHTML = "";
      pair("Name", w.full_name);
      pair("Phone", w.phone);
      if (w.alt_phone) pair("Alt phone", w.alt_phone);
      pair("Area", w.area);
      pair("Address", w.address);

      d.zone.value = w.inside_dhaka ? "100" : "200";
      recomputeCod();
      d.note.value = w.title + (w.spec ? " — " + w.spec : "");

      if (w.already_sent) {
        dSay("Already sent to Steadfast.", "done");
        showSent(w.consignment_id, w.tracking_code);
      }

      d.panel.hidden = false;
    }).catch(function (err) {
      // Say so, but never let it keep the "put one up" form off the screen.
      dispatchTrouble("Could not load the winner's details: " +
                      (err && err.message ? err.message : "unknown error") +
                      ". If this says the function is missing, steadfast.sql " +
                      "has not been run yet.");
    });
  }

  // pg_net answers after the transaction, so ask again rather than guess.
  function pollResult(db, tries) {
    return db.rpc("steadfast_result", { p_auction_id: dispatchId }).then(function (r) {
      if (r.error) throw new Error(r.error.message);
      var res = r.data && r.data[0];
      if (!res) throw new Error("no answer");

      if (res.state === "done") {
        dSay("Sent. Steadfast have the parcel.", "done");
        showSent(res.consignment_id, res.tracking_code);
        return;
      }
      if (res.state === "failed") {
        d.send.disabled = false;
        dSay("Steadfast refused it: " + res.detail, "error");
        return;
      }
      if (tries <= 0) {
        dSay("Sent, but Steadfast have not answered yet. Reload in a moment " +
             "to see the consignment number.", "done");
        return;
      }
      return new Promise(function (ok) { setTimeout(ok, 1500); })
        .then(function () { return pollResult(db, tries - 1); });
    });
  }

  function sendDispatch() {
    var db = window.AUCTION_DB;
    if (!db || !dispatchId) return;

    var cod = Number(d.cod.value);
    if (!(cod > 0)) { dSay("Set the amount to collect.", "error"); return; }

    d.send.disabled = true;
    dSay("Sending…");

    db.rpc("send_to_steadfast", {
      p_auction_id: dispatchId,
      p_cod: cod,
      p_note: d.note.value || null
    }).then(function (r) {
      if (r.error) throw new Error(r.error.message);
      return pollResult(db, 4);
    }).catch(function (err) {
      d.send.disabled = false;
      dSay(err && err.message ? err.message : "That did not go through.", "error");
    });
  }

  function start() {
    if (d.panel) {
      d.zone.addEventListener("change", recomputeCod);
      d.send.addEventListener("click", sendDispatch);
      loadDispatch(window.AUCTION_DB);
    }

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
  }

  /* --- Go -------------------------------------------------------------------- */

  wireGate();

  if (!window.AUCTION_SOURCE) {
    showGate(true);
    var m = document.getElementById("gate-msg");
    if (m) {
      m.className = "admin__msg is-error";
      m.textContent = "The database connection did not load, so signing in cannot work yet.";
    }
    return;
  }

  var forceOut = /[?&]signedout=1/.test(location.search);

  window.AUCTION_SOURCE.session().then(function (session) {
    if (forceOut || !session) { showGate(true); return; }
    showGate(false);
    start();
  }).catch(function () {
    showGate(true);
  });
})();
