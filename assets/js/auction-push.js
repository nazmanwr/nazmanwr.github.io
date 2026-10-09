/* ==========================================================================
   auction-push.js — asking to be told, and being told

   The auction page already emails a bidder when they are outbid. This is the
   half of that message which arrives in seconds rather than whenever somebody
   next opens their inbox: a notification on the phone, whether or not the page
   is open. It also carries the one alert email never sent at all — that a new
   lot has opened — which is why it is offered to visitors with no account.

   Three things are true of every browser and they decide everything here:

     1. A subscription cannot be made without the person agreeing to it, and
        the asking must happen inside a tap. Everything below hangs off a
        button for that reason, not for decoration.

     2. On iPhone there are no web alerts at all until the site has been added
        to the Home Screen. That is Apple's rule, it cannot be worked around,
        and saying so plainly is more use than a button that does nothing.

     3. A subscription belongs to the browser, not to the person. Signing in
        later has to be told about it, or an anonymous subscriber who becomes a
        bidder would never hear that they had been outbid — which is the one
        message that matters most.
   ========================================================================== */

(function () {
  "use strict";

  var cfg    = window.AUCTION_CONFIG || {};
  var source = window.AUCTION_SOURCE || null;
  var hosts  = document.querySelectorAll("[data-alerts]");

  if (!hosts.length || !source || !cfg.vapid) return;

  var state = {
    mode: "unsupported",   // unsupported | install | blocked | off | on
    busy: false,
    message: "",
    subscription: null
  };

  /* --- What this device can do ---------------------------------------------- */

  var ua = navigator.userAgent;
  var isIOS = /iPad|iPhone|iPod/.test(ua) ||
              (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var installed = window.navigator.standalone === true ||
                  window.matchMedia("(display-mode: standalone)").matches;

  function canPush() {
    return "serviceWorker" in navigator &&
           "PushManager" in window &&
           "Notification" in window;
  }

  /* --- Keys ------------------------------------------------------------------
     subscribe() wants the signing key as bytes, not as the text it is written
     in everywhere else.
  -------------------------------------------------------------------------- */

  function keyBytes(value) {
    var padded = (value + "=".repeat((4 - (value.length % 4)) % 4))
                   .replace(/-/g, "+").replace(/_/g, "/");
    var raw = window.atob(padded);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  /* --- Drawing ---------------------------------------------------------------
     There are two of these on the page — one beside the bid buttons and one in
     the empty state, because somebody arriving between lots is exactly who
     wants to hear about the next one. They are drawn from one piece of state
     so they can never disagree.
  -------------------------------------------------------------------------- */

  var COPY = {
    install: {
      note: "On iPhone, alerts only work once this page is on your Home Screen. " +
            "Tap Share, then Add to Home Screen, and open it from there. " +
            "Until then we can only email you.",
      button: null
    },
    blocked: {
      note: "Alerts are switched off for this site in your browser's settings. " +
            "Turn notifications back on there, then reload this page.",
      button: null
    },
    off: {
      note: "Be told the moment a new lot opens, and if someone outbids you. " +
            "No account needed, and it stops whenever you say.",
      button: "Alert me"
    },
    on: {
      note: "Alerts are on for this device. You will hear when a lot opens and " +
            "if you are outbid.",
      button: "Turn off"
    }
  };

  function draw() {
    for (var i = 0; i < hosts.length; i++) paint(hosts[i]);
  }

  function paint(host) {
    if (state.mode === "unsupported") { host.hidden = true; return; }

    var copy = COPY[state.mode];
    host.hidden = false;
    host.innerHTML = "";

    var label = document.createElement("p");
    label.className = "clock__label";
    label.textContent = "Alerts";
    host.appendChild(label);

    var note = document.createElement("p");
    note.className = "alerts__note";
    note.textContent = copy.note;
    host.appendChild(note);

    if (copy.button) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn" + (state.mode === "off" ? " btn--primary" : "");
      btn.textContent = state.busy ? "One moment…" : copy.button;
      btn.disabled = state.busy;
      btn.addEventListener("click", state.mode === "off" ? turnOn : turnOff);
      host.appendChild(btn);
    }

    if (state.message) {
      var msg = document.createElement("p");
      msg.className = "alerts__msg";
      msg.textContent = state.message;
      host.appendChild(msg);
    }
  }

  function say(text) {
    state.message = text || "";
    draw();
  }

  /* --- Turning them on -------------------------------------------------------
     requestPermission() has to be the first thing the tap does. Safari refuses
     it if anything has been awaited first, so nothing is looked up beforehand.
  -------------------------------------------------------------------------- */

  function turnOn() {
    if (state.busy) return;
    state.busy = true;
    state.message = "";
    draw();

    Promise.resolve(Notification.requestPermission()).then(function (permission) {
      if (permission !== "granted") {
        // "denied" is a decision the browser will remember, and it can only be
        // undone in its settings — so the answer is the standing explanation,
        // not an error. A prompt merely dismissed can just be asked again.
        state.busy = false;
        state.mode = permission === "denied" ? "blocked" : "off";
        say(permission === "denied" ? "" : "No alerts then — ask again whenever you like.");
        return null;
      }

      return navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.getSubscription().then(function (existing) {
          return existing || reg.pushManager.subscribe({
            // Required, and honest: every push this site sends shows something.
            userVisibleOnly: true,
            applicationServerKey: keyBytes(cfg.vapid)
          });
        });
      }).then(function (sub) {
        return source.savePushSubscription(sub).then(function () {
          state.subscription = sub;
          state.mode = "on";
          state.busy = false;
          say("");
        });
      });
    }).catch(function (err) {
      state.busy = false;
      say((err && err.message) || "That did not work. Try again in a moment.");
    });
  }

  /* --- And off ---------------------------------------------------------------
     The row goes as well as the subscription. Leaving it would mean sending
     alerts into an address that has stopped listening, which costs a request
     per lot per browser for as long as the site exists.
  -------------------------------------------------------------------------- */

  function turnOff() {
    if (state.busy || !state.subscription) return;
    state.busy = true;
    draw();

    var endpoint = state.subscription.endpoint;

    state.subscription.unsubscribe().then(function () {
      return source.forgetPushSubscription(endpoint);
    }).then(function () {
      state.subscription = null;
      state.mode = "off";
      state.busy = false;
      say("");
    }).catch(function (err) {
      state.busy = false;
      say((err && err.message) || "Could not turn them off. Try again.");
    });
  }

  /* --- Where we stand on load ------------------------------------------------ */

  function look() {
    // The iPhone case first. On a phone that has not been installed there is no
    // PushManager to ask, so testing support before this would send everyone to
    // the wrong answer.
    if (isIOS && !installed) { state.mode = "install"; draw(); return; }

    if (!canPush()) { state.mode = "unsupported"; draw(); return; }

    if (Notification.permission === "denied") { state.mode = "blocked"; draw(); return; }

    navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      state.subscription = sub || null;
      state.mode = sub ? "on" : "off";
      draw();

      // Say hello again on every load, for two reasons. A subscription made
      // before signing in has no account attached to it, and until it does its
      // owner cannot be told they have been outbid. And a row deleted at the
      // far end — a push service that reported this browser gone, wrongly or
      // after a long silence — comes back rather than staying lost.
      if (sub) source.savePushSubscription(sub).catch(function () { /* next load */ });
    }).catch(function () {
      state.mode = "off";
      draw();
    });
  }

  look();
})();
