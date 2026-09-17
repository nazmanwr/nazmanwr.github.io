/* ==========================================================================
   sw.js — service worker

   The point of this file: open a demo once on good wifi, and it still runs
   if the connection dies in the middle of a client meeting.

   >>> BUMP `VERSION` WHENEVER YOU CHANGE SITE FILES. <<<
   That is what forces iPads to pick up the new build instead of serving
   a stale demo from cache.
   ========================================================================== */

var VERSION = "v30";
var SHELL   = "shell-" + VERSION;
var RUNTIME = "runtime-" + VERSION;

var PRECACHE = [
  "/",
  "/index.html",
  "/work.html",
  "/workshop.html",
  "/about.html",
  "/404.html",
  "/demos/",
  "/demos/index.html",
  "/assets/css/site.css",
  "/assets/css/catalog.css",
  "/assets/css/demo-shell.css",
  "/assets/css/demos-white.css",
  "/assets/js/site.js",
  "/assets/js/catalog.js",
  "/assets/js/model-viewer.js",
  "/assets/css/model-viewer.css",
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

  // Everything else: serve instantly from cache, refresh in the background.
  event.respondWith(staleWhileRevalidate(request));
});
