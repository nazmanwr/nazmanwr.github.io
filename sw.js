/* ==========================================================================
   sw.js — service worker

   The point of this file: open a demo once on good wifi, and it still runs
   if the connection dies in the middle of a client meeting.

   >>> BUMP `VERSION` WHENEVER YOU CHANGE SITE FILES. <<<
   That is what forces iPads to pick up the new build instead of serving
   a stale demo from cache.
   ========================================================================== */

var VERSION = "v51";
var SHELL   = "shell-" + VERSION;
var RUNTIME = "runtime-" + VERSION;

/* The auction's alerts are delivered here, to this file, whether or not the
   page is open — that is the whole point of them. These three values are the
   public ones: the project it talks to, the key that identifies the project
   without granting anything, and the public half of the signing key. They are
   repeated from auction-config.js rather than imported because a service
   worker is woken with no page attached and nothing else loaded. */
var PUSH = {
  url:   "https://ipwpeeoesesmerzsenoe.supabase.co",
  key:   "sb_publishable_2-4Z1B4cnpx_UDnlYVQ03A_GulNLoHm",
  vapid: "BG-siLK1pcarwMWURfHBEsY_oz7y3Ky-seI1oyzdD7yeufE-vbdQd966mB0EX1TriXFkeRfS1PrRJFEdNqagahY"
};

var PRECACHE = [
  "/",
  "/index.html",
  "/work.html",
  "/workshop.html",
  "/auction.html",
  "/about.html",
  "/404.html",
  "/demos/",
  "/demos/index.html",
  "/assets/css/site.css",
  "/assets/css/catalog.css",
  "/assets/css/auction.css",
  "/assets/css/demo-shell.css",
  "/assets/css/demos-white.css",
  "/assets/js/site.js",
  "/assets/js/catalog.js",
  "/assets/js/auction.js",
  "/assets/js/auction-config.js",
  "/assets/js/auction-banner.js",
  "/assets/js/auction-push.js",
  "/auction.webmanifest",
  "/assets/vendor/supabase/supabase.js",
  "/assets/js/bd-areas.js",
  "/assets/js/model-viewer.js",
  "/assets/css/model-viewer.css",
  "/assets/js/sketchup-viewer.js",
  "/assets/js/deck.js",
  "/assets/js/launcher.js",
  "/assets/js/demo-shell.js",
  "/assets/img/icon-32.png",
  "/assets/img/icon-192.png",
  "/assets/img/icon-180.png",
  "/data/demos.json",
  "/manifest.webmanifest"
];

/* --- Install --------------------------------------------------------------- */

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL).then(function (cache) {
      // Cache entries one at a time: a single 404 in the list would make
      // cache.addAll() reject and abort the whole install.
      return Promise.all(PRECACHE.map(function (url) {
        return cache.add(new Request(url, { cache: "reload" }))
          .catch(function () { /* missing file — skip, don't fail install */ });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

/* --- Activate -------------------------------------------------------------- */

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL && k !== RUNTIME) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("message", function (event) {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

/* --- Strategies ------------------------------------------------------------ */

/* Caching can fail — most often QuotaExceededError, since a single demo here
   can carry tens of MB of 3D models and iOS Safari is stingy with storage in a
   normal tab (much more generous once the site is added to the Home Screen).
   A failed cache write must never reject the response the page is waiting on. */
function cachePut(request, response) {
  return caches.open(RUNTIME)
    .then(function (c) { return c.put(request, response); })
    .catch(function (err) {
      console.warn("[sw] could not cache", request.url, err && err.name);
    });
}

function networkFirst(request, fallbackUrl) {
  return fetch(request).then(function (response) {
    if (response && response.ok) cachePut(request, response.clone());
    return response;
  }).catch(function () {
    return caches.match(request).then(function (hit) {
      if (hit) return hit;
      if (fallbackUrl) return caches.match(fallbackUrl);
      return new Response("Offline", {
        status: 503,
        headers: { "Content-Type": "text/plain" }
      });
    });
  });
}

function staleWhileRevalidate(request) {
  return caches.match(request).then(function (hit) {
    var net = fetch(request).then(function (response) {
      if (response && response.ok) cachePut(request, response.clone());
      return response;
    }).catch(function () { return hit; });

    return hit || net;
  });
}

/* --- Fetch ----------------------------------------------------------------- */

self.addEventListener("fetch", function (event) {
  var request = event.request;

  if (request.method !== "GET") return;

  var url;
  try { url = new URL(request.url); } catch (e) { return; }

  // Leave cross-origin traffic alone — external demos, fonts, CDNs.
  if (url.origin !== self.location.origin) return;

  // Video goes straight to the network. Players fetch media with Range
  // requests, the 206 responses they get back cannot be put in the cache
  // anyway, and sitting in the middle of that only risks breaking seeking.
  // The poster frames next to them are ordinary images and stay cached.
  if (url.pathname.indexOf("/assets/video/") === 0 && url.pathname.slice(-4) === ".mp4") return;

  // Page loads: prefer fresh, fall back to cache, then to the 404 page.
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "/404.html"));
    return;
  }

  // The demo list changes often enough that freshness beats speed.
  if (url.pathname.endsWith("/data/demos.json")) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Scripts and styles go network-first too. Under stale-while-revalidate a
  // deploy always arrives one load late: the page's HTML is fresh, its
  // JavaScript is the previous version, and the result looks exactly like a
  // feature that failed to ship — which is how an hour went missing chasing
  // a Steadfast button that was already live. The cache still answers when
  // the network does not, so offline is unaffected.
  if (url.pathname.slice(-3) === ".js" || url.pathname.slice(-4) === ".css") {
    event.respondWith(networkFirst(request));
    return;
  }

  // Everything else: serve instantly from cache, refresh in the background.
  event.respondWith(staleWhileRevalidate(request));
});

/* --- Alerts ----------------------------------------------------------------

   A push arrives here even when nobody has the site open — the browser starts
   this worker for the few milliseconds it takes to show the notification. That
   is the difference between this and the email: it is read now, not whenever
   somebody next opens their inbox.

   The body was encrypted to this browser's own key before it left the
   database, so the push service that carried it could not read what the
   artwork is or what it is going for.
--------------------------------------------------------------------------- */

self.addEventListener("push", function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }

  // showNotification is not optional. A browser that is handed a push and
  // shows nothing eventually has its permission taken away, so there is always
  // something to show even if the payload arrived empty.
  var title = data.title || "NAZM ANWR";

  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "Something has happened in the auction.",
      icon: data.icon || "/assets/img/icon-192.png",
      badge: "/assets/img/icon-192.png",
      // One tag per lot, so a run of quick raises replaces the last alert
      // rather than stacking five of them up the screen.
      tag: data.tag || "auction",
      renotify: true,
      data: { url: data.url || "/auction.html" }
    })
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();

  var target = (event.notification.data && event.notification.data.url) || "/auction.html";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true })
      .then(function (list) {
        // Somebody watching the auction already should be brought back to the
        // tab they were watching it in, not given a second one.
        for (var i = 0; i < list.length; i++) {
          if (list[i].url.indexOf("/auction.html") !== -1 && "focus" in list[i]) {
            return list[i].focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(target);
      })
  );
});

/* Push services rotate a subscription from time to time, and the old address
   stops working the moment they do. The browser tells us when it happens; if
   we do not take up the new one here, the alerts simply stop and nobody finds
   out until an auction has been missed. */

function urlBase64ToUint8Array(value) {
  var padded = (value + "=".repeat((4 - (value.length % 4)) % 4))
                 .replace(/-/g, "+").replace(/_/g, "/");
  var raw = self.atob(padded);
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function tellTheDatabase(fn, body) {
  return fetch(PUSH.url + "/rest/v1/rpc/" + fn, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: PUSH.key,
      Authorization: "Bearer " + PUSH.key
    },
    body: JSON.stringify(body)
  });
}

self.addEventListener("pushsubscriptionchange", function (event) {
  event.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(PUSH.vapid)
    }).then(function (sub) {
      var json = sub.toJSON();
      return tellTheDatabase("save_push_subscription", {
        p_endpoint: sub.endpoint,
        p_p256dh: json.keys.p256dh,
        p_auth: json.keys.auth,
        p_user_agent: self.navigator ? self.navigator.userAgent : null
      }).then(function () {
        var old = event.oldSubscription;
        if (old) {
          return tellTheDatabase("forget_push_subscription", { p_endpoint: old.endpoint });
        }
      });
    }).catch(function (err) {
      console.warn("[sw] could not renew the push subscription", err);
    })
  );
});
