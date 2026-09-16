/* ==========================================================================
   deck.js — swipeable slide deck, no dependencies

   Markup it expects:

     <div class="deck" data-deck>
       <section class="slide">…</section>
       <section class="slide">…</section>
     </div>

   It builds the nav bar itself. Controls: swipe, arrow keys, space,
   Home/End, on-screen buttons, and dot indicators.
   ========================================================================== */

(function () {
  "use strict";

  function Deck(root) {
    var slides = Array.prototype.slice.call(root.querySelectorAll(".slide"));
    if (!slides.length) return;

    var index = 0;
    var nav, prevBtn, nextBtn, dots, count;

    /* --- Build the nav ---------------------------------------------------- */

    function buildNav() {
      nav = document.createElement("div");
      nav.className = "deck-nav";

      prevBtn = document.createElement("button");
      prevBtn.type = "button";
      prevBtn.setAttribute("aria-label", "Previous slide");
      prevBtn.innerHTML = "&#8592;";
      prevBtn.addEventListener("click", function () { go(index - 1); });

      nextBtn = document.createElement("button");
      nextBtn.type = "button";
      nextBtn.setAttribute("aria-label", "Next slide");
      nextBtn.innerHTML = "&#8594;";
      nextBtn.addEventListener("click", function () { go(index + 1); });

      dots = document.createElement("div");
      dots.className = "deck-dots";
      slides.forEach(function (_, i) {
        var d = document.createElement("button");
        d.type = "button";
        d.setAttribute("aria-label", "Go to slide " + (i + 1));
        d.addEventListener("click", function () { go(i); });
        dots.appendChild(d);
      });

      count = document.createElement("span");
      count.className = "deck-count";

      nav.append(prevBtn, dots, nextBtn, count);
      root.parentNode.insertBefore(nav, root.nextSibling);
    }

    /* --- Move ------------------------------------------------------------- */

    function go(n) {
      index = Math.max(0, Math.min(slides.length - 1, n));
      render();
    }

    function render() {
      slides.forEach(function (s, i) {
        s.classList.toggle("is-active", i === index);
        s.classList.toggle("is-past", i < index);
        // Keep off-screen slides out of the accessibility tree and tab order.
        s.setAttribute("aria-hidden", i === index ? "false" : "true");
        s.inert = i !== index;
      });

      prevBtn.disabled = index === 0;
      nextBtn.disabled = index === slides.length - 1;
      count.textContent = index + 1 + " / " + slides.length;

      Array.prototype.forEach.call(dots.children, function (d, i) {
        d.setAttribute("aria-current", i === index ? "true" : "false");
      });

      root.dispatchEvent(new CustomEvent("deck:change", {
        detail: { index: index, total: slides.length }
      }));
    }

    /* --- Keyboard ---------------------------------------------------------- */

    function onKey(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case "ArrowRight": case "PageDown": case " ": go(index + 1); break;
        case "ArrowLeft":  case "PageUp":         go(index - 1); break;
        case "Home": go(0); break;
        case "End":  go(slides.length - 1); break;
        default: return;
      }
      e.preventDefault();
    }

    /* --- Touch -------------------------------------------------------------
       Horizontal intent only. A mostly-vertical drag is left alone so the
       slide can still scroll if its content overflows.
    ------------------------------------------------------------------------ */

    var startX = 0, startY = 0, tracking = false;
    var THRESHOLD = 45;   // px before a drag counts as a swipe

    function onStart(e) {
      var t = e.changedTouches[0];
      startX = t.clientX;
      startY = t.clientY;
      tracking = true;
    }

    function onEnd(e) {
      if (!tracking) return;
      tracking = false;

      var t = e.changedTouches[0];
      var dx = t.clientX - startX;
      var dy = t.clientY - startY;

      if (Math.abs(dx) < THRESHOLD) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.2) return;  // too vertical

      go(dx < 0 ? index + 1 : index - 1);
    }

    /* --- Init -------------------------------------------------------------- */

    buildNav();
    render();

    document.addEventListener("keydown", onKey);
    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchend", onEnd, { passive: true });

    // Let a demo drive the deck if it wants to.
    root.deck = { go: go, next: function () { go(index + 1); },
                  prev: function () { go(index - 1); },
                  get index() { return index; } };
  }

  function init() {
    document.querySelectorAll("[data-deck]").forEach(Deck);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
