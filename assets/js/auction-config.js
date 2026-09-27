/* ==========================================================================
   auction-config.js — where the auction page gets its data

   Right now this runs in PREVIEW mode: made-up numbers, so the page can be
   looked at and argued with before any backend exists. Nothing here is real
   and no bid placed on it goes anywhere.

   When the Supabase project is ready this file is replaced with the real
   client: same three functions — load(), placeBid(), subscribe() — so
   auction.js itself does not change.
   ========================================================================== */

window.AUCTION_CONFIG = {
  preview: true,
  supabaseUrl: "",      // Project Settings -> API -> Project URL
  supabaseAnonKey: ""   // Project Settings -> API -> anon public
};

/* --- Preview data ---------------------------------------------------------
   A lot mid-flight, deliberately inside the last three hours so the closing
   state is visible.
-------------------------------------------------------------------------- */

(function () {
  "use strict";

  if (!window.AUCTION_CONFIG.preview) return;

  // Who the preview signs you in as. Every bid you place carries this name,
  // the way a real bid carries the name you signed up with.
  var ME = "Mostafizur Rahman Khan";

  // Nothing is running by default. A made-up lot with made-up bidders must
  // never be what a visitor meets on the live site, so the page starts empty
  // and only fills if this browser has published one from the admin screen.
  var auction = null;
  var bids = [];

  // If a lot was published from the admin screen in this browser, show that
  // instead of the built-in one, so the whole loop can be walked: fill the
  // form, publish, come here, bid.
  try {
    var saved = localStorage.getItem("auction:preview");
    if (saved) {
      var parsed = JSON.parse(saved);
      if (parsed && parsed.auction) {
        auction = parsed.auction;
        bids = Array.isArray(parsed.bids) ? parsed.bids : [];
      }
    }
  } catch (err) {
    // Blocked storage or bad JSON: fall back to the built-in lot.
  }

  function persist() {
    try {
      localStorage.setItem("auction:preview", JSON.stringify({ auction: auction, bids: bids }));
    } catch (err) { /* preview only — losing it costs nothing */ }
  }

  window.AUCTION_SOURCE = {
    load: function () {
      return Promise.resolve({
        auction: auction,
        bids: bids,
        signed_in: true,
        server_time: new Date().toISOString()
      });
    },

    placeBid: function (amount) {
      if (!auction) return Promise.reject(new Error("No auction is running."));

      // Mirrors what place_bid() does server-side, so the preview behaves the
      // way the real thing will — including the three-hour extension.
      var highest = bids.length ? bids[0].amount : null;
      var minimum = highest === null ? auction.start_price : highest + auction.increment;

      if (amount < minimum) {
        return Promise.reject(new Error("The lowest you can bid now is BDT " +
          minimum.toLocaleString("en-US") + "."));
      }

      bids.unshift({
        id: String(bids.length + 1),
        amount: amount,
        display_name: ME,
        is_you: true,
        created_at: new Date().toISOString()
      });

      var left = new Date(auction.ends_at) - Date.now();
      if (left <= 3 * 60 * 60 * 1000) {
        auction.ends_at = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
      }

      persist();

      return Promise.resolve();
    },

    signIn: function () {
      return Promise.resolve();
    }
  };
})();
