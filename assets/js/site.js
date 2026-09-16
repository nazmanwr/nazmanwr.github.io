/* ==========================================================================
   site.js — shared behaviour for every page
   Progressive enhancement only: the site works fully with JS disabled.
   ========================================================================== */

(function () {
  "use strict";

  /* --- Mark the current nav item ----------------------------------------- */

  function markCurrentNav() {
    var here = location.pathname.replace(/\/index\.html$/, "/");
    document.querySelectorAll(".nav a").forEach(function (a) {
      var target = new URL(a.getAttribute("href"), location.href).pathname
        .replace(/\/index\.html$/, "/");
      if (target === here) a.setAttribute("aria-current", "page");
    });
  }

  /* --- Service worker ------------------------------------------------------
     Gives us offline demos. Only registers over https (or localhost) —
     opening the files directly from disk will simply skip this.
  -------------------------------------------------------------------------- */

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "https:" && location.hostname !== "localhost") return;

    navigator.serviceWorker.register("/sw.js").catch(function (err) {
      // Never let a SW problem break the page — worst case, no offline support.
      console.warn("[site] service worker registration failed:", err);
    });
  }

  /* --- Offline indicator ---------------------------------------------------
     Worth having in a client meeting: if the wifi dies you want to know it
     was the network, not your demo.
  -------------------------------------------------------------------------- */

  function offlineNotice() {
    var note = document.createElement("div");
    note.className = "offline-note";
    note.setAttribute("role", "status");
    note.textContent = "Offline — running from cache";
    document.body.appendChild(note);

    function sync() {
      note.classList.toggle("is-shown", !navigator.onLine);
    }
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    sync();
  }

  /* --- Year stamp in the footer ------------------------------------------- */

  function stampYear() {
    var el = document.querySelector("[data-year]");
    if (el) el.textContent = new Date().getFullYear();
  }

  /* --- Go ----------------------------------------------------------------- */

  function init() {
    markCurrentNav();
    stampYear();
    offlineNotice();
    registerSW();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
