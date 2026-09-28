/* ==========================================================================
   auction-config.js — the auction's connection to Supabase

   Exposes the same three-and-a-bit functions the preview did — load(),
   placeBid(), subscribe(), plus the sign-in helpers — so auction.js and
   auction-banner.js did not change when this replaced the mock.

   The key below is the publishable one. It is meant to be in the page: it
   identifies the project, it does not grant anything. What may actually be
   read or written is decided by the row-level rules in schema.sql, which is
   why a bidder's phone number and address stay unreadable even though this
   file is public.
   ========================================================================== */

window.AUCTION_CONFIG = {
  url: "https://ipwpeeoesesmerzsenoe.supabase.co",
  key: "sb_publishable_2-4Z1B4cnpx_UDnlYVQ03A_GulNLoHm"
};

(function () {
  "use strict";

  if (typeof supabase === "undefined" || !supabase.createClient) {
    console.warn("[auction] the Supabase library did not load");
    return;
  }

  var db = supabase.createClient(
    window.AUCTION_CONFIG.url,
    window.AUCTION_CONFIG.key,
    { auth: { persistSession: true, autoRefreshToken: true } }
  );

  window.AUCTION_DB = db;     // the admin screen uses the same connection

  // How long a finished auction keeps announcing its winner before the page
  // goes back to normal.
  var WINNER_SHOWN_FOR_HOURS = 48;

  var skewMs = 0;
  var skewTaken = false;

  /* --- The clock ------------------------------------------------------------
     Read from the server's own Date header rather than from this device. The
     countdown is only a display — place_bid() judges a bid against the database
     clock regardless — but a visitor whose laptop is an hour out should still
     see the right number.
  -------------------------------------------------------------------------- */

  function takeClock() {
    if (skewTaken) return Promise.resolve();
    return fetch(window.AUCTION_CONFIG.url + "/rest/v1/", {
      method: "HEAD",
      headers: { apikey: window.AUCTION_CONFIG.key }
    }).then(function (res) {
      var d = res.headers.get("date");
      if (d) { skewMs = new Date(d) - Date.now(); skewTaken = true; }
    }).catch(function () { /* keep the local clock; it is only the display */ });
  }

  function serverNow() { return Date.now() + skewMs; }

  /* --- Reading --------------------------------------------------------------- */

  function currentAuction() {
    // Newest first: one lot runs at a time, so the newest row is the one that
    // matters — either running, or just finished and still naming its winner.
    return db.from("auctions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1)
      .then(function (r) {
        if (r.error) throw r.error;
        var a = (r.data && r.data[0]) || null;
        if (!a) return null;

        if (a.status === "closed") {
          var over = serverNow() - new Date(a.ends_at);
          if (over > WINNER_SHOWN_FOR_HOURS * 3600 * 1000) return null;
        }
        return a;
      });
  }

  function bidsFor(auctionId, myId) {
    return db.from("public_bids")
      .select("id, auction_id, amount, created_at, display_name, bidder_id")
      .eq("auction_id", auctionId)
      .order("amount", { ascending: false })
      .order("created_at", { ascending: true })
      .then(function (r) {
        if (r.error) throw r.error;
        return (r.data || []).map(function (b) {
          return {
            id: b.id,
            amount: b.amount,
            created_at: b.created_at,
            display_name: b.display_name,
            is_you: !!myId && b.bidder_id === myId
          };
        });
      });
  }

  /* --- Sign-in errors worth explaining --------------------------------------
     The one that matters is the sending limit. Left as it comes back it reads
     like the site is broken, when in fact the email never left — so say so,
     and say what to do instead, because someone standing in front of an
     auction that is running will not wait quietly.
  -------------------------------------------------------------------------- */

  function readable(error) {
    var msg = (error && error.message) || "";

    // "For security purposes, you can only request this after 47 seconds."
    var wait = msg.match(/after (\d+) seconds/i);
    if (wait) {
      return "Give it " + wait[1] + " seconds and ask again — one has just " +
             "gone out to this address.";
    }

    if (/rate limit/i.test(msg) || (error && error.status === 429)) {
      return "Too many sign-in emails have been sent in the last hour, so " +
             "this one could not go out. Try again a little later, or ring " +
             "01557454040 and your bid can be placed for you.";
    }

    return msg || "That did not work.";
  }

  /* --- Who is bidding --------------------------------------------------------
     The bidders table holds a phone number and a home address, so it is fenced
     off by row-level rules: a bidder may read and write exactly one row, their
     own. This is that read and that write. Nobody — not another bidder, not
     this page on someone else's device — can reach anyone else's.
  -------------------------------------------------------------------------- */

  function profileFor(user) {
    if (!user) return Promise.resolve(null);
    return db.from("bidders")
      .select("id, full_name, phone, alt_phone, district, thana, address, email")
      .eq("id", user.id)
      .maybeSingle()
      .then(function (r) {
        if (r.error) throw r.error;
        return r.data || null;
      })
      .catch(function () { return null; });   // never block the page on this
  }

  /* --- The shape auction.js expects ------------------------------------------ */

  window.AUCTION_SOURCE = {

    load: function () {
      return takeClock()
        .then(function () { return db.auth.getSession(); })
        .then(function (s) {
          var user = s && s.data && s.data.session && s.data.session.user;
          var myId = user ? user.id : null;

          return Promise.all([currentAuction(), profileFor(user)])
            .then(function (both) {
              var auction = both[0];
              var profile = both[1];

              var base = {
                auction: auction,
                bids: [],
                signed_in: !!user,
                email: user ? user.email : null,
                profile: profile,
                server_time: new Date(serverNow()).toISOString()
              };

              if (!auction) return base;

              return bidsFor(auction.id, myId).then(function (bids) {
                base.bids = bids;
                return base;
              });
            });
        });
    },

    // Written only after the sign-in link has been opened, because until then
    // there is no account to attach it to.
    saveProfile: function (d) {
      return db.auth.getSession().then(function (s) {
        var user = s && s.data && s.data.session && s.data.session.user;
        if (!user) throw new Error("You are not signed in yet.");

        return db.from("bidders").upsert({
          id: user.id,
          full_name: d.full_name,
          phone: d.phone,
          alt_phone: d.alt_phone || null,
          district: d.district || null,
          thana: d.thana || null,
          address: d.address,
          email: d.email || user.email
        }).select("id, full_name, phone, alt_phone, district, thana, address, email").single();
      }).then(function (r) {
        if (r.error) throw new Error(r.error.message);
        return r.data;
      });
    },

    // Everything about whether this is allowed — signed in, high enough, still
    // open, and whether the close moves — is decided inside place_bid().
    placeBid: function (amount) {
      return db.rpc("place_bid", { p_auction_id: window.AUCTION_CURRENT_ID, p_amount: amount })
        .then(function (r) {
          if (r.error) throw new Error(r.error.message || "That bid was refused.");
          return r.data;
        });
    },

    // Live updates when the table is published for realtime (see owner.sql).
    // Without it the page polls, which it does anyway as a safety net.
    subscribe: function (onChange) {
      try {
        db.channel("bids-live")
          .on("postgres_changes",
              { event: "INSERT", schema: "public", table: "bids" },
              function () { onChange(); })
          .subscribe();
      } catch (err) {
        // Realtime not enabled: polling covers it.
      }
    },

    /* --- Accounts ----------------------------------------------------------- */

    signIn: function (email) {
      return db.auth.signInWithOtp({
        email: email,
        options: { emailRedirectTo: location.origin + location.pathname }
      }).then(function (r) {
        if (r.error) throw new Error(readable(r.error));
        return true;
      });
    },

    signOut: function () { return db.auth.signOut(); },

    session: function () {
      return db.auth.getSession().then(function (s) {
        return (s && s.data && s.data.session) || null;
      });
    }
  };
})();
