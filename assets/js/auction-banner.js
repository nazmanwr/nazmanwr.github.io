/* ==========================================================================
   auction-banner.js — the live-auction strip that sits above a page's list

   Appears only while an auction is actually running. The moment it closes and
   a winner is announced, the strip removes itself and the page is exactly what
   it was before — no "auction ended" leftovers cluttering the catalogue.

   It reads the same source as the auction page, so there is one definition of
   what is live and one countdown, not two that can disagree.
   ========================================================================== */

(function () {
  "use strict";

  var host = document.getElementById("auction-banner");
  var source = window.AUCTION_SOURCE;
  if (!host || !source) return;

  var state = { auction: null, bids: [], skew: 0 };

  function taka(n) {
    return "BDT " + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  }

  function serverNow() { return Date.now() + state.skew; }

  function isLive(a) {
    if (!a || a.status === "closed") return false;
    var now = serverNow();
    return now >= new Date(a.starts_at) && now < new Date(a.ends_at);
  }

  function twoDigits(n) { return n < 10 ? "0" + n : String(n); }

  function left() {
    var ms = new Date(state.auction.ends_at) - serverNow();
    if (ms <= 0) return null;
    var s = Math.floor(ms / 1000);
    var d = Math.floor(s / 86400);
    var h = Math.floor((s % 86400) / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    return {
      text: d > 0
        ? d + "d " + twoDigits(h) + ":" + twoDigits(m) + ":" + twoDigits(sec)
        : twoDigits(h) + ":" + twoDigits(m) + ":" + twoDigits(sec),
      closing: ms <= 3 * 3600 * 1000
    };
  }

  function build() {
    var a = state.auction;
    var highest = state.bids.length ? state.bids[0].amount : null;

    host.innerHTML = "";

    var link = document.createElement("a");
    link.className = "abanner";
    link.href = "/auction.html";

    var media = document.createElement("span");
    media.className = "abanner__media";
    var img = document.createElement("img");
    img.src = a.image_path;
    img.alt = "";
    img.decoding = "async";
    media.appendChild(img);

    var body = document.createElement("span");
    body.className = "abanner__body";

    var tag = document.createElement("span");
    tag.className = "abanner__tag";
    tag.textContent = "Live auction";

    var title = document.createElement("span");
    title.className = "abanner__title";
    title.textContent = a.title;

    var facts = document.createElement("span");
    facts.className = "abanner__facts";
    facts.textContent = (highest === null
      ? "Opening at " + taka(a.start_price)
      : "Highest bid " + taka(highest)) +
      (state.bids.length ? " · " + state.bids.length +
        (state.bids.length === 1 ? " bid" : " bids") : " · no bids yet");

    body.append(tag, title, facts);

    var clock = document.createElement("span");
    clock.className = "abanner__clock";
    var time = document.createElement("span");
    time.className = "abanner__time";
    var label = document.createElement("span");
    label.className = "abanner__label";
    clock.append(label, time);

    var cta = document.createElement("span");
    cta.className = "abanner__cta";
    cta.textContent = "Place a bid";

    link.append(media, body, clock, cta);
    host.appendChild(link);

    host.hidden = false;
    tick();
  }

  function tick() {
    if (!state.auction) return;
    var time = host.querySelector(".abanner__time");
    var label = host.querySelector(".abanner__label");
    var link = host.querySelector(".abanner");
    if (!time) return;

    var l = left();
    if (!l) { host.hidden = true; return; }   // it ended while being looked at

    time.textContent = l.text;
    label.textContent = l.closing ? "Closing" : "Time left";
    link.classList.toggle("is-closing", l.closing);
  }

  function refresh() {
    source.load().then(function (data) {
      if (data.server_time) state.skew = new Date(data.server_time) - Date.now();
      state.auction = data.auction;
      state.bids = data.bids || [];

      if (!isLive(state.auction)) { host.hidden = true; host.innerHTML = ""; return; }
      build();
    }).catch(function () {
      // A page's own content must never depend on the auction loading.
      host.hidden = true;
    });
  }

  refresh();
  setInterval(tick, 1000);
  setInterval(refresh, 30000);
})();
