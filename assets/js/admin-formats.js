/* ==========================================================================
   admin-formats.js — reading and writing the public pages' HTML

   The home, work and workshop pages stay plain static HTML: no data file, no
   script filling them in, so they load as fast and fail as rarely as they
   always have. The editors in /admin/ work by reading the list out of the
   page, changing it, and writing the same markup back.

   That only works if the markup written back is the markup a person would
   have written. So each format here is a matched pair, parse and render, and
   render(parse(page)) gives back the page byte for byte. Change one side and
   change the other.

   No DOM in here — plain strings — so it runs in Node for checking as well as
   in the browser.
   ========================================================================== */

(function (root) {
  "use strict";

  /* --- Text ----------------------------------------------------------------- */

  function decode(s) {
    return String(s)
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }

  function text(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function attr(s) {
    return text(s).replace(/"/g, "&quot;");
  }

  function grab(re, s) {
    var m = re.exec(s);
    return m ? decode(m[1]) : "";
  }

  function pad(s, n) { return new Array(n + 1).join(" ") + s; }

  // Indents every line but the first, which sits wherever it is placed.
  function indent(block, n) {
    return block.split("\n").map(function (line, i) {
      return i === 0 || !line ? line : pad(line, n);
    }).join("\n");
  }

  // The list sits between an opening tag and the first closing </ul> after it.
  // Nothing inside any of these lists contains a <ul> of its own.
  function region(html, open) {
    var start = html.indexOf(open);
    if (start < 0) throw new Error("could not find " + open + " in the page");
    var bodyStart = start + open.length;
    var close = /\n[ \t]*<\/ul>/g;
    close.lastIndex = bodyStart;
    var m = close.exec(html);
    if (!m) throw new Error("could not find the end of " + open);
    return { before: html.slice(0, bodyStart), body: html.slice(bodyStart, m.index),
             after: html.slice(m.index) };
  }

  function list(items, n) {
    if (!items.length) return "\n";
    return "\n\n" + pad("", n) + items.join("\n\n" + pad("", n)) + "\n";
  }

  // The first screenful loads straight away; the rest wait until scrolled to.
  var EAGER = 6;

  /* --- Home: the catalogue -------------------------------------------------- */

  var home = {
    parse: function (html) {
      var r = region(html, '<ul class="pieces">');
      var items = [];
      var re = /<li class="piece"( data-sold)?>([\s\S]*?)<\/li>/g, m;
      while ((m = re.exec(r.body))) {
        var li = m[2];
        var img = /<img src="([^"]*)" alt="([^"]*)" width="(\d+)" height="(\d+)"/.exec(li) || [];
        var dds = [], d, dre = /<dd( class="is-sold")?>([\s\S]*?)<\/dd>/g;
        while ((d = dre.exec(li))) dds.push(d[2]);

        var priceHtml = dds[1] || "";
        var sold = !!m[1];
        var price, note = "";
        if (/<s>/.test(priceHtml)) {
          price = grab(/<s>([\s\S]*?)<\/s>/, priceHtml);
        } else {
          note = grab(/<em>([\s\S]*?)<\/em>/, priceHtml);
          price = decode(priceHtml.replace(/<em>[\s\S]*?<\/em>/, "").trim());
        }

        items.push({
          full: grab(/<a class="piece__hit" href="([^"]*)"/, li),
          src: decode(img[1] || ""),
          alt: decode(img[2] || ""),
          w: Number(img[3]) || 0,
          h: Number(img[4]) || 0,
          title: grab(/<h2 class="piece__title">([\s\S]*?)<\/h2>/, li),
          size: decode(dds[0] || ""),
          price: price,
          note: note,
          sold: sold
        });
      }
      return items;
    },

    renderItem: function (p, i) {
      var price = p.sold
        ? '<dd class="is-sold"><s>' + text(p.price) + "</s> <em>Sold</em></dd>"
        : "<dd>" + text(p.price) + (p.note ? " <em>" + text(p.note) + "</em>" : "") + "</dd>";
      return indent([
        '<li class="piece"' + (p.sold ? " data-sold" : "") + ">",
        "  <figure>",
        '    <a class="piece__hit" href="' + attr(p.full) + '">',
        '    <div class="piece__media">',
        '      <img src="' + attr(p.src) + '" alt="' + attr(p.alt) + '" width="' + p.w +
          '" height="' + p.h + '" loading="' + (i < EAGER ? "eager" : "lazy") + '" decoding="async">',
        "    </div>",
        "    </a>",
        "    <figcaption>",
        '      <h2 class="piece__title">' + text(p.title) + "</h2>",
        '      <dl class="piece__spec">',
        "        <dt>Size</dt>",
        "        <dd>" + text(p.size) + "</dd>",
        "        <dt>Price</dt>",
        "        " + price,
        "      </dl>",
        "    </figcaption>",
        "  </figure>",
        "</li>"
      ].join("\n"), 8);
    },

    render: function (html, items) {
      var r = region(html, '<ul class="pieces">');
      return r.before + list(items.map(home.renderItem), 8) + r.after;
    }
  };

  /* --- Work: the films ------------------------------------------------------ */

  var work = {
    parse: function (html) {
      var r = region(html, '<ul class="films">');
      var items = [];
      var re = /<li class="film">([\s\S]*?)<\/li>/g, m;
      while ((m = re.exec(r.body))) {
        var li = m[1];
        items.push({
          src: grab(/<source src="([^"]*)"/, li),
          type: grab(/<source [^>]*type="([^"]*)"/, li) || "video/mp4",
          poster: grab(/poster="([^"]*)"/, li),
          w: Number(grab(/width="(\d+)"/, li)) || 1280,
          h: Number(grab(/height="(\d+)"/, li)) || 720,
          title: grab(/<h2 class="film__title">([\s\S]*?)<\/h2>/, li)
        });
      }
      return items;
    },

    renderItem: function (f) {
      var lines = [
        '<li class="film">',
        '  <div class="film__frame">',
        '    <video controls preload="none" playsinline'
      ];
      if (f.poster) lines.push('           poster="' + attr(f.poster) + '"');
      lines.push(
        '           width="' + f.w + '" height="' + f.h + '">',
        '      <source src="' + attr(f.src) + '" type="' + attr(f.type || "video/mp4") + '">',
        "    </video>",
        "  </div>",
        '  <h2 class="film__title">' + text(f.title) + "</h2>",
        "</li>"
      );
      return indent(lines.join("\n"), 6);
    },

    render: function (html, items) {
      var r = region(html, '<ul class="films">');
      return r.before + list(items.map(work.renderItem), 6) + r.after;
    }
  };

  /* --- Workshop: photographs in albums --------------------------------------
     Albums are sections between two markers. A page written before albums
     existed has one bare gallery instead; that reads as a single album with no
     title, and the first save writes it out in the new shape.
  -------------------------------------------------------------------------- */

  var OPEN = "<!-- albums -->";
  var CLOSE = "<!-- /albums -->";

  function parseShots(body) {
    var shots = [];
    var re = /<li class="shot">([\s\S]*?)<\/li>/g, m;
    while ((m = re.exec(body))) {
      var li = m[1];
      var img = /<img src="([^"]*)" alt="([^"]*)" width="(\d+)" height="(\d+)"/.exec(li) || [];
      shots.push({
        full: grab(/<a class="piece__hit" href="([^"]*)"/, li),
        src: decode(img[1] || ""),
        alt: decode(img[2] || ""),
        w: Number(img[3]) || 0,
        h: Number(img[4]) || 0
      });
    }
    return shots;
  }

  function workshopRegion(html) {
    var a = html.indexOf(OPEN), b = html.indexOf(CLOSE);
    if (a >= 0 && b > a) {
      var lineStart = html.lastIndexOf("\n", a) + 1;
      return { before: html.slice(0, lineStart), body: html.slice(a + OPEN.length, b),
               after: html.slice(b + CLOSE.length), marked: true };
    }
    // The older page: the bare gallery, along with the EDIT note above it.
    var g = html.indexOf('<ul class="gallery">');
    if (g < 0) throw new Error('could not find the albums or <ul class="gallery"> in the page');
    var end = html.indexOf("</ul>", g) + 5;
    var from = g;
    var note = html.lastIndexOf("<!-- EDIT", g);
    if (note >= 0 && !/\S/.test(html.slice(html.indexOf("-->", note) + 3, g))) from = note;
    return { before: html.slice(0, html.lastIndexOf("\n", from) + 1), body: html.slice(g, end),
             after: html.slice(end), marked: false };
  }

  var workshop = {
    parse: function (html) {
      var r = workshopRegion(html);
      if (!r.marked) return [{ title: "", photos: parseShots(r.body) }];
      var albums = [];
      var re = /<section class="album"(?: hidden)?>([\s\S]*?)<\/section>/g, m;
      while ((m = re.exec(r.body))) {
        albums.push({
          title: grab(/<h2 class="album__title">([\s\S]*?)<\/h2>/, m[1]),
          photos: parseShots(m[1])
        });
      }
      return albums;
    },

    renderShot: function (s, i) {
      return indent([
        '<li class="shot">',
        '  <a class="piece__hit" href="' + attr(s.full) + '">',
        '    <div class="piece__media">',
        '      <img src="' + attr(s.src) + '" alt="' + attr(s.alt) + '" width="' + s.w +
          '" height="' + s.h + '" loading="' + (i < EAGER ? "eager" : "lazy") + '" decoding="async">',
        "    </div>",
        "  </a>",
        "</li>"
      ].join("\n"), 8);
    },

    render: function (html, albums) {
      var r = workshopRegion(html);
      var n = 0;
      var sections = albums.map(function (a) {
        var shots = a.photos.map(function (s) { return workshop.renderShot(s, n++); });
        // An album with nothing in it yet is kept, but not shown.
        return '    <section class="album"' + (a.photos.length ? "" : " hidden") + ">\n" +
          (a.title ? '      <h2 class="album__title">' + text(a.title) + "</h2>\n" : "") +
          '      <ul class="gallery">' + list(shots, 8) + "\n      </ul>\n" +
          "    </section>";
      });
      return r.before + "    " + OPEN + "\n" + sections.join("\n\n") + "\n    " + CLOSE + r.after;
    }
  };

  var api = { home: home, work: work, workshop: workshop };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AdminFormats = api;
})(this);
