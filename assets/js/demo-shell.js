/* ==========================================================================
   demo-shell.js — presentation chrome for an individual demo

   Hides the top bar while you present and brings it back on any interaction,
   so the client sees the demo and not your navigation.
   ========================================================================== */

(function () {
  "use strict";

  var bar = document.querySelector(".demo-bar");
  if (!bar) return;

  var IDLE_MS = 3000;
  var timer = null;

  function show() {
    bar.classList.remove("is-hidden");
    clearTimeout(timer);
    timer = setTimeout(hide, IDLE_MS);
  }

  function hide() {
    // Don't yank the bar away while someone is tabbed into it.
    if (bar.contains(document.activeElement)) return;
    bar.classList.add("is-hidden");
  }

  ["pointermove", "pointerdown", "keydown", "touchstart", "focusin"].forEach(function (evt) {
    document.addEventListener(evt, show, { passive: true });
  });

  show();
})();
