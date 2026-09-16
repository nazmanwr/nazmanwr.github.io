/* ==========================================================================
   catalog.js — the artwork viewer

   Progressive enhancement. Every thumbnail is already a plain link to its
   image file, so with JS off, or before this script runs, clicking one still
   shows the artwork. All this does is intercept that click and open the
   picture in a dialog instead.

   The browser Back button closes the viewer. That is the whole reason opening
   it pushes a history entry: on an iPad the back swipe is how people expect to
   leave something that filled the screen, and without the entry that gesture
   would take them off the site altogether.
   ========================================================================== */

(function () {
  "use strict";

  var dlg = document.querySelector(".lightbox");
  if (!dlg || typeof dlg.showModal !== "function") return; // no <dialog>: links stay as-is

  var panel   = dlg.querySelector(".lightbox__panel");
  var img     = dlg.querySelector(".lightbox__img");
  var titleEl = dlg.querySelector(".lightbox__title");
  var specEl  = dlg.querySelector(".lightbox__spec");
  var closeBtn = dlg.querySelector(".lightbox__close");

  var hits = Array.prototype.slice.call(document.querySelectorAll(".piece__hit"));
  if (!hits.length) return;

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  /* Must match the transition duration in catalog.css. The dialog can only be
     closed once the fade has finished, and transitionend alone is not safe —
     it never fires if the element is display:none'd mid-flight. */
  var FADE_MS = 420;

  var isOpen = false;
  var fadeTimer = null;
  var lastFocus = null;

  /* --- Filling the panel --------------------------------------------------- */

  function fill(hit) {
    var piece = hit.closest(".piece");
    var thumb = hit.querySelector("img");
    var title = piece ? piece.querySelector(".piece__title") : null;
    var specs = piece ? piece.querySelectorAll(".piece__spec dd") : [];

    img.src = hit.getAttribute("href");
    img.alt = thumb ? thumb.getAttribute("alt") : "";

    titleEl.textContent = title ? title.textContent : "";

    // The dd list is [size, price]; the price may carry a trailing note.
    var bits = [];
    for (var i = 0; i < specs.length; i++) {
      bits.push(specs[i].textContent.replace(/\s+/g, " ").trim());
    }
    specEl.textContent = bits.join("  ·  ");
  }

  /* --- Open / close --------------------------------------------------------
     show() and hide() do the visible work. They never touch history, so that
     the popstate handler can call them without recursing.
  -------------------------------------------------------------------------- */

  function show(hit) {
    if (fadeTimer) { clearTimeout(fadeTimer); fadeTimer = null; }

    fill(hit);
    lastFocus = hit;
    isOpen = true;

    if (!dlg.open) dlg.showModal();
    document.documentElement.classList.add("has-lightbox");

    // Park focus on the panel. Left to itself the dialog focuses the close
    // button, which then wears a focus ring for a plain mouse click.
    if (panel) panel.focus();

    // Reading a layout property flushes the closed styles, giving the
    // transition a starting point to animate from. Done synchronously on
    // purpose: waiting on requestAnimationFrame means the panel stays at
    // opacity 0 for as long as the browser withholds frames, and a viewer
    // that is open but invisible traps the page behind a modal nobody can see.
    void dlg.offsetWidth;
    dlg.classList.add("is-open");
  }

  function hide() {
    if (!isOpen) return;
    isOpen = false;

    dlg.classList.remove("is-open");
    document.documentElement.classList.remove("has-lightbox");

    var finish = function () {
      fadeTimer = null;
      if (dlg.open) dlg.close();
      img.removeAttribute("src");
      if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
    };

    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(finish, reduced.matches ? 0 : FADE_MS);
  }

  /* --- History -------------------------------------------------------------
     Opening pushes an entry. Everything that dismisses the viewer goes through
     history.back() instead of closing directly, so the button, the backdrop,
     Escape and the Back gesture all leave the history stack in the same state.
  -------------------------------------------------------------------------- */

  function open(hit) {
    var index = hits.indexOf(hit);
    if (index < 0) return;
    history.pushState({ lightbox: index }, "");
    show(hit);
  }

  function dismiss() {
    if (!isOpen) return;
    if (history.state && history.state.lightbox != null) {
      history.back(); // popstate does the closing
    } else {
      hide();
    }
  }

  window.addEventListener("popstate", function (event) {
    var state = event.state;
    if (state && state.lightbox != null && hits[state.lightbox]) {
      show(hits[state.lightbox]); // forward button, back into an open viewer
    } else {
      hide();
    }
  });

  /* --- Wiring -------------------------------------------------------------- */

  hits.forEach(function (hit) {
    hit.addEventListener("click", function (event) {
      // Leave modified clicks alone — open in a new tab still works.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (event.button && event.button !== 0) return;

      event.preventDefault();
      open(hit);
    });
  });

  // A click landing on the dialog itself is a click on the backdrop: the panel
  // covers every part of the dialog that is not backdrop.
  dlg.addEventListener("click", function (event) {
    if (event.target === dlg) dismiss();
  });

  closeBtn.addEventListener("click", dismiss);

  // Escape: cancel the browser's own close so it can go through history too.
  dlg.addEventListener("cancel", function (event) {
    event.preventDefault();
    dismiss();
  });
})();
