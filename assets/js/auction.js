/* ==========================================================================
   auction.js — the live auction page

   Two rules shape this file.

   1. The browser is never trusted with time. The server sends its own clock
      with every read; we keep the difference and run the countdown off that.
      Someone who sets their laptop back three hours sees the same clock as
      everyone else, and in any case the bid itself is judged in the database.

   2. The browser is never trusted with the rules. The buttons below compute
      a suggested amount so the page can show one, but place_bid() in Postgres
      decides what is actually accepted. If the two ever disagree, the database
      wins and the page shows its error.

   Everything that talks to Supabase sits behind `source`, defined in
   auction-config.js, so this file is only ever about what is on the screen.
   ========================================================================== */

(function () {
  "use strict";

  var cfg = window.AUCTION_CONFIG || {};
  var EXTENSION_HOURS = 3;

  var el = {
    empty: document.getElementById("no-lot"),
    lot: document.getElementById("lot"),
    image: document.getElementById("lot-image"),
    hit: document.getElementById("lot-hit"),
    title: document.getElementById("lot-title"),
    spec: document.getElementById("lot-spec"),
    clock: document.getElementById("clock"),
    clockLabel: document.getElementById("clock-label"),
    time: document.getElementById("clock-time"),
    ends: document.getElementById("clock-ends"),
    clockName: document.getElementById("clock-name"),
    leaderLabel: document.getElementById("leader-label"),
    clockNote: document.getElementById("clock-note"),
    standing: document.getElementById("standing"),
    amount: document.getElementById("standing-amount"),
    who: document.getElementById("standing-who"),
    bidbox: document.getElementById("bidbox"),
    quick: document.getElementById("bid-quick"),
    bump: document.getElementById("bid-bump"),
    custom: document.getElementById("bid-custom"),
    customGo: document.getElementById("bid-custom-go"),
    msg: document.getElementById("bid-msg"),
    total: document.getElementById("bid-total"),
    confirm: document.getElementById("bid-confirm"),
    confirmMsg: document.getElementById("confirm-msg"),
    confirmTotal: document.getElementById("confirm-total"),
    yes: document.getElementById("confirm-yes"),
    no: document.getElementById("confirm-no"),
    history: document.getElementById("history-list"),
    historyWrap: document.getElementById("history"),
    result: document.getElementById("result"),
    resultName: document.getElementById("result-name"),
    install: document.getElementById("install-note"),
    join: document.getElementById("join"),
    joinForm: document.getElementById("join-form"),
    joinMsg: document.getElementById("join-msg"),
    jName: document.getElementById("j-name"),
    jPhone: document.getElementById("j-phone"),
    jAltPhone: document.getElementById("j-alt-phone"),
    jDistrict: document.getElementById("j-district"),
    jThana: document.getElementById("j-thana"),
    jAddress: document.getElementById("j-address"),
    jEmail: document.getElementById("j-email")
  };

  var state = {
    auction: null,
    bids: [],
    clockSkewMs: 0,      // serverNow - browserNow
    signedIn: false,
    profile: null,       // the bidder's own row, once they have one
    busy: false
  };

  /* --- Money ---------------------------------------------------------------
     Bengali auctions are in taka and the amounts are read aloud on the phone,
     so group them the ordinary way rather than in lakh notation.
  -------------------------------------------------------------------------- */

  function taka(n) {
    return "BDT " + Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  }

  function serverNow() {
    return new Date(Date.now() + state.clockSkewMs);
  }

  /* --- Countdown ------------------------------------------------------------ */

  function twoDigits(n) { return n < 10 ? "0" + n : String(n); }

  function renderClock() {
    if (!state.auction) return;

    var ends = new Date(state.auction.ends_at);
    var left = ends - serverNow();

    if (state.auction.status === "closed" || left <= 0) {
      el.clockLabel.textContent = "Closed";
      el.time.textContent = "—";
      el.clock.classList.remove("is-closing");
      el.ends.textContent = "Ended " + ends.toLocaleString();

      // Past tense once it is over. "Highest bidder now" on a finished auction
      // reads as though it is still running, and the rule about the last three
      // hours has nothing left to govern.
      if (el.leaderLabel) el.leaderLabel.textContent = "Winner";
      if (el.clockNote) el.clockNote.hidden = true;
      return;
    }

    if (el.leaderLabel) el.leaderLabel.textContent = "Highest bidder now";
    if (el.clockNote) el.clockNote.hidden = false;

    var secs = Math.floor(left / 1000);
    var days = Math.floor(secs / 86400);
    var hours = Math.floor((secs % 86400) / 3600);
    var mins = Math.floor((secs % 3600) / 60);
    var rest = secs % 60;

    el.time.textContent = days > 0
      ? days + "d " + twoDigits(hours) + ":" + twoDigits(mins) + ":" + twoDigits(rest)
      : twoDigits(hours) + ":" + twoDigits(mins) + ":" + twoDigits(rest);

    // Inside the extension window the page changes character: this is the
    // stretch where a bid moves the deadline.
    var closing = left <= EXTENSION_HOURS * 3600 * 1000;
    el.clock.classList.toggle("is-closing", closing);
    el.clockLabel.textContent = closing ? "Closing — every bid adds 3 hours" : "Time left";
    el.ends.textContent = "Scheduled to close " + ends.toLocaleString();
  }

  /* --- What may be bid next ------------------------------------------------- */

  function minimumNext() {
    if (!state.auction) return 0;
    var highest = state.bids.length ? Number(state.bids[0].amount) : null;
    return highest === null
      ? Number(state.auction.start_price)
      : highest + Number(state.auction.increment);
  }

  function group(n) {
    return Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
  }

  // The two quick buttons raise the standing bid by +100 and +1000.
  //
  // Neither may ever offer a bid the database would refuse, so both are floored
  // at the lowest raise set for this lot: ask for +100 on a lot whose lowest
  // raise is 500 and the button offers +500 and says so. Before the first bid
  // there is nothing to add to, so the first button opens at the starting bid.
  function quickOptions() {
    var highest = state.bids.length ? Number(state.bids[0].amount) : null;
    var raise = Number(state.auction.increment) || 0;

    if (highest === null) {
      var start = Number(state.auction.start_price);
      var firstJump = Math.max(1000, raise);
      return [
        { label: taka(start), amount: start, raise: start },
        { label: "+" + group(firstJump), amount: start + firstJump, raise: firstJump }
      ];
    }

    var small = Math.max(100, raise);
    var large = Math.max(1000, raise);
    return [
      { label: "+" + group(small), amount: highest + small, raise: small },
      { label: "+" + group(large), amount: highest + large, raise: large }
    ];
  }

  function renderBidBox() {
    var min = minimumNext();
    var options = quickOptions();

    el.quick.textContent = options[0].label;
    el.quick.dataset.amount = String(options[0].amount);

    el.bump.textContent = options[1].label;
    el.bump.dataset.raise = String(options[1].raise);

    // If someone else bid while this confirmation was open, the amount it was
    // asking about is no longer the right one. Take it away rather than place
    // a bid they did not agree to.
    if (el.confirm && !el.confirm.hidden &&
        el.bump.dataset.amount !== String(options[1].amount)) {
      dismissConfirm();
      say("Someone else bid — check the new amount.", true);
    }

    el.bump.dataset.amount = String(options[1].amount);

    // Both buttons show what they cost, since a bare "+100" hides the total.
    el.quick.title = "Bid " + taka(options[0].amount);
    el.bump.title = "Bid " + taka(options[1].amount);

    // The box is a raise, matching the +100 / +1,000 buttons beside it, so the
    // placeholder shows the smallest raise allowed — not the smallest total.
    // Before the first bid there is nothing to raise, so it takes the opening
    // bid itself and says so.
    var opening = state.bids.length === 0;
    el.custom.placeholder = "Minimum bid " +
      taka(opening ? state.auction.start_price : state.auction.increment);
    el.custom.min = String(opening ? state.auction.start_price : state.auction.increment);
    renderCustomTotal();

    var open = state.auction && state.auction.status !== "closed" &&
               (new Date(state.auction.ends_at) - serverNow()) > 0;

    [el.quick, el.bump, el.customGo].forEach(function (b) {
      b.disabled = !open || state.busy;
    });
    el.custom.disabled = !open || state.busy;

    // Someone who has not signed up yet gets the sign-up form in place of the
    // buttons, rather than buttons that turn out not to work. Once the auction
    // is over, neither belongs on the page: a dead "Place a bid" box invites a
    // tap that can only be refused.
    var ready = !!state.profile;
    el.bidbox.hidden = !state.auction || !open || (!ready && open);
    renderJoin(open && !ready);
  }

  /* --- Signing up ------------------------------------------------------------
     Two halves, split by an email round trip. Before the link is opened there
     is no account, so the details are held on this device; after it, they are
     written to the bidder's own row and the local copy is thrown away.
  -------------------------------------------------------------------------- */

  var STASH = "auction:signup";

  function stash(d) {
    try { sessionStorage.setItem(STASH, JSON.stringify(d)); } catch (err) {}
  }

  function takeStash() {
    try {
      var raw = sessionStorage.getItem(STASH);
      if (!raw) return null;
      sessionStorage.removeItem(STASH);
      return JSON.parse(raw);
    } catch (err) { return null; }
  }

  // One form, one wording, whoever is looking at it. The signed-in-but-no-
  // details case is handled in onJoin without showing a second version of the
  // panel — see there for why it cannot simply be dropped.
  function renderJoin(show) {
    if (!el.join) return;
    el.join.hidden = !show;
  }

  function joinSay(text, isError) {
    el.joinMsg.textContent = text || "";
    el.joinMsg.classList.toggle("is-error", !!isError);
  }

  /* --- District and thana ----------------------------------------------------
     Two dependent lists rather than a typed area, so what arrives is a name the
     courier's own system recognises. Guessing the thana out of a free-text
     address is where parcels go astray, and it is also what decides the
     delivery charge.
  -------------------------------------------------------------------------- */

  function buildAreas() {
    var areas = window.BD_AREAS;
    if (!areas || !el.jDistrict) return;

    Object.keys(areas).forEach(function (name) {
      var o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      el.jDistrict.appendChild(o);
    });

    el.jDistrict.addEventListener("change", function () {
      var list = areas[el.jDistrict.value] || [];

      el.jThana.innerHTML = "";
      var first = document.createElement("option");
      first.value = "";
      first.textContent = list.length ? "Choose…" : "Choose a district first";
      el.jThana.appendChild(first);

      list.forEach(function (t) {
        var o = document.createElement("option");
        o.value = t;
        o.textContent = t;
        el.jThana.appendChild(o);
      });

      el.jThana.disabled = !list.length;
    });
  }

  function details() {
    return {
      full_name: el.jName.value.trim(),
      phone: el.jPhone.value.trim(),
      alt_phone: el.jAltPhone ? el.jAltPhone.value.trim() : "",
      district: el.jDistrict ? el.jDistrict.value : "",
      thana: el.jThana ? el.jThana.value : "",
      address: el.jAddress.value.trim(),
      email: el.jEmail.value.trim()
    };
  }

  function saveDetails(d) {
    joinSay("Saving…");
    return source.saveProfile(d).then(function (row) {
      state.profile = row;
      joinSay("");
      renderAll(false);
      say("You can bid now.");
    }).catch(function (err) {
      joinSay(err && err.message ? err.message : "Those details would not save.", true);
    });
  }

  function onJoin(e) {
    e.preventDefault();
    var d = details();

    if (!d.full_name || !d.phone || !d.address) {
      joinSay("Name, phone and address are all needed.", true);
      return;
    }

    if (!d.district || !d.thana) {
      joinSay("Choose your district and area — the courier needs it.", true);
      return;
    }

    if (!d.email) { joinSay("An email address is needed for the link.", true); return; }

    // Signed in already, but with no details saved — which happens when the
    // form is filled in one browser and the emailed link is opened in another,
    // as it is whenever Gmail opens the link inside its own app. Sending a
    // second link would only repeat that, so save what they have typed and let
    // them bid. Nothing about the panel looks different to them.
    if (state.signedIn) { saveDetails(d); return; }

    joinSay("Sending…");
    stash(d);
    source.signIn(d.email).then(function () {
      joinSay("Check " + d.email + ". Opening the link brings you back here, " +
              "signed in and ready to bid.");
    }).catch(function (err) {
      joinSay("Could not send it: " + (err && err.message), true);
    });
  }

  // Coming back from the email link: the account now exists, so the details
  // that were waiting on this device can be written.
  function finishSignUp() {
    if (!state.signedIn || state.profile) return;
    var held = takeStash();
    if (held && held.full_name) saveDetails(held);
  }

  /* --- The custom box -------------------------------------------------------
     What someone types is an amount to add. Once there is a standing bid the
     total is highest + typed; before that, the typed number is the opening bid
     itself, because there is nothing yet to add to.
  -------------------------------------------------------------------------- */

  function customToTotal(raw) {
    var typed = Number(raw);
    if (!isFinite(typed) || typed <= 0) return NaN;
    if (!state.bids.length) return typed;
    return Number(state.bids[0].amount) + typed;
  }

  function renderCustomTotal() {
    if (!el.total) return;
    var total = customToTotal(el.custom.value);
    el.total.textContent = isFinite(total) ? "That bids " + taka(total) : "";
  }

  // Refuse in the same units the person typed. They entered a raise, so being
  // told "the lowest you can bid is BDT 46,100" answers a question they did not
  // ask; "the smallest raise is BDT 100" does.
  function bidFromCustom() {
    var typed = Number(el.custom.value);
    var opening = state.bids.length === 0;
    var floor = opening
      ? Number(state.auction.start_price)
      : Number(state.auction.increment);

    if (!isFinite(typed) || typed <= 0) {
      say("Enter an amount to add.", true);
      return;
    }
    if (typed < floor) {
      say(opening
        ? "The opening bid is at least " + taka(floor) + "."
        : "The smallest raise is " + taka(floor) + ".", true);
      return;
    }
    bid(customToTotal(el.custom.value));
  }

  /* --- Rendering ------------------------------------------------------------ */

  function renderLeaderName() {
    if (!el.clockName) return;
    if (!state.bids.length) {
      el.clockName.textContent = "Nobody yet";
      el.clockName.classList.add("is-empty");
      return;
    }
    var top = state.bids[0];
    el.clockName.classList.remove("is-empty");
    el.clockName.textContent = top.display_name;
  }

  function renderStanding(flash) {
    renderLeaderName();
    if (!state.bids.length) {
      el.amount.textContent = taka(state.auction.start_price);
      el.who.textContent = "No bids yet — this is the opening price.";
      return;
    }

    var top = state.bids[0];
    el.amount.textContent = taka(top.amount);

    el.who.innerHTML = "";
    el.who.append(
      document.createTextNode(
        state.bids.length + (state.bids.length === 1 ? " bid" : " bids") + " · held by "
      )
    );
    var name = document.createElement("strong");
    name.className = "standing__leader";
    name.textContent = top.display_name;
    el.who.appendChild(name);

    if (flash) {
      el.standing.classList.remove("just-changed");
      void el.standing.offsetWidth;          // restart the animation
      el.standing.classList.add("just-changed");
    }
  }

  function relative(when) {
    var secs = Math.floor((serverNow() - new Date(when)) / 1000);
    if (secs < 60) return "just now";
    if (secs < 3600) return Math.floor(secs / 60) + " min ago";
    if (secs < 86400) return Math.floor(secs / 3600) + " hr ago";
    return new Date(when).toLocaleDateString();
  }

  function renderHistory() {
    el.history.innerHTML = "";

    state.bids.forEach(function (b, i) {
      var leading = i === 0;                 // the list is sorted highest first

      var li = document.createElement("li");
      if (leading) li.className = "is-leading";

      var who = document.createElement("span");
      who.className = "history__who";
      who.textContent = b.display_name;

      // Say which of the two it is. "Leading" is the fact; "you" is the part
      // that makes somebody act on it — and once it is over, leading is won.
      if (leading) {
        var over = state.auction && state.auction.status === "closed";
        var tag = document.createElement("span");
        tag.className = "history__tag";
        tag.textContent = over
          ? (b.is_you ? "You won" : "Won")
          : (b.is_you ? "You are leading" : "Leading");
        who.appendChild(tag);
      } else if (b.is_you) {
        var mine = document.createElement("span");
        mine.className = "history__tag history__tag--quiet";
        mine.textContent = "Your bid";
        who.appendChild(mine);
      }

      var when = document.createElement("span");
      when.className = "history__when";
      when.textContent = relative(b.created_at);
      who.appendChild(when);

      var amt = document.createElement("span");
      amt.className = "history__amount";
      amt.textContent = taka(b.amount);

      li.append(who, amt);
      el.history.appendChild(li);
    });

    el.historyWrap.hidden = state.bids.length === 0;
  }

  function renderResult() {
    var closed = state.auction && state.auction.status === "closed";
    el.result.hidden = !closed;
    if (!closed) return;
    el.resultName.textContent = state.bids.length
      ? state.bids[0].display_name + " — " + taka(state.bids[0].amount)
      : "No bids were placed.";
  }

  function renderAll(flash) {
    if (!state.auction) {
      el.empty.hidden = false;
      el.lot.hidden = true;
      return;
    }
    el.empty.hidden = true;
    el.lot.hidden = false;

    el.image.src = state.auction.image_path;
    el.image.alt = state.auction.title;
    el.hit.href = state.auction.image_path;
    el.title.textContent = state.auction.title;
    el.spec.textContent = [state.auction.medium, state.auction.size]
      .filter(Boolean).join(" · ");

    renderClock();
    renderStanding(flash);
    renderHistory();
    renderBidBox();
    renderResult();
  }

  /* --- Confirming the larger jump -------------------------------------------
     +1,000 is a real sum here, and on a phone it sits a thumb-width from the
     small one. It asks first; the small button does not, because a confirm on
     every tap trains people to dismiss confirms.
  -------------------------------------------------------------------------- */

  var pending = null;

  function askConfirm(amount, raise) {
    pending = amount;
    el.confirmMsg.textContent =
      "Are you sure you want to raise the bid by " + taka(raise) + "?";
    el.confirmTotal.textContent = "That bids " + taka(amount) + ".";
    el.confirm.hidden = false;
    el.yes.focus();
  }

  function dismissConfirm() {
    pending = null;
    el.confirm.hidden = true;
  }

  /* --- Bidding -------------------------------------------------------------- */

  function say(text, isError) {
    el.msg.textContent = text || "";
    el.msg.classList.toggle("is-error", !!isError);
  }

  function bid(amount) {
    if (state.busy) return;
    amount = Number(amount);

    if (!isFinite(amount) || amount <= 0) {
      say("Enter an amount to bid.", true);
      return;
    }
    if (amount < minimumNext()) {
      say("The lowest you can bid now is " + taka(minimumNext()) + ".", true);
      return;
    }
    if (!state.profile) {
      say("Sign up first — it takes a minute.", true);
      renderJoin(true);
      el.join.scrollIntoView({ behavior: "smooth", block: "nearest" });
      el.jName.focus();
      return;
    }

    state.busy = true;
    renderBidBox();
    say("Placing your bid…");

    source.placeBid(amount).then(function () {
      state.busy = false;
      say("Your bid is in. You'll be told if someone outbids you.");
      return refresh(true);
    }).catch(function (err) {
      state.busy = false;
      say(err && err.message ? err.message : "That bid could not be placed.", true);
      renderBidBox();
    });
  }

  /* --- Data ----------------------------------------------------------------- */

  var source = window.AUCTION_SOURCE || null;

  function refresh(flash) {
    if (!source) return Promise.resolve();
    return source.load().then(function (data) {
      // Trust the server's clock, not this device's.
      if (data.server_time) {
        state.clockSkewMs = new Date(data.server_time) - Date.now();
      }
      window.AUCTION_CURRENT_ID = data.auction ? data.auction.id : null;
      state.auction = data.auction;
      state.bids = data.bids || [];
      state.signedIn = !!data.signed_in;
      state.profile = data.profile || null;
      if (data.email && el.jEmail && !el.jEmail.value) el.jEmail.value = data.email;
      renderAll(flash);
      finishSignUp();
    }).catch(function (err) {
      say("Could not reach the auction. " + (err && err.message ? err.message : ""), true);
    });
  }

  /* --- iPhone install prompt ------------------------------------------------ */

  function maybeOfferInstall() {
    if (!el.install) return;
    var ua = navigator.userAgent;
    var isIOS = /iPad|iPhone|iPod/.test(ua) ||
                (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    var standalone = window.navigator.standalone === true ||
                     window.matchMedia("(display-mode: standalone)").matches;
    el.install.hidden = !(isIOS && !standalone);
  }

  /* --- Go ------------------------------------------------------------------- */

  el.quick.addEventListener("click", function () { bid(this.dataset.amount); });
  el.bump.addEventListener("click", function () {
    askConfirm(Number(this.dataset.amount), Number(this.dataset.raise));
  });

  el.yes.addEventListener("click", function () {
    var amount = pending;
    dismissConfirm();
    if (amount !== null) bid(amount);
  });

  el.no.addEventListener("click", function () {
    dismissConfirm();
    el.bump.focus();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !el.confirm.hidden) dismissConfirm();
  });
  el.customGo.addEventListener("click", bidFromCustom);
  el.custom.addEventListener("input", renderCustomTotal);
  el.custom.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); bidFromCustom(); }
  });

  buildAreas();
  if (el.joinForm) el.joinForm.addEventListener("submit", onJoin);

  maybeOfferInstall();
  refresh(false);

  setInterval(renderClock, 1000);        // the clock never stops
  setInterval(function () { refresh(true); }, 15000);  // and neither do other people

  if (source && typeof source.subscribe === "function") {
    source.subscribe(function () { refresh(true); });
  }
})();
