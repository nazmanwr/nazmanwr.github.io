/* ==========================================================================
   admin-site.js — what the home, work and workshop editors share

   Those three pages are static files on GitHub Pages, so there is no server to
   send a change to. A change is a commit instead: the editor writes the new
   page and any new pictures or films straight into the repository through the
   GitHub API, and Pages republishes the site about a minute later.

   That needs a GitHub token, made once and pasted in once per device. It is
   kept in this browser's storage and sent to nobody but api.github.com. The
   token is the whole of the protection — the editor pages themselves are
   public, as every file here must be — so it should be a fine-grained one
   that can touch this repository's contents and nothing else.

   Every save also bumps VERSION in sw.js, in the same commit, so iPads that
   have the site cached pick the change up instead of serving the old page.
   ========================================================================== */

(function () {
  "use strict";

  var OWNER = "nazmanwr";
  var REPO = "nazmanwr.github.io";
  var BRANCH = "main";
  var API = "https://api.github.com/repos/" + OWNER + "/" + REPO;
  var TOKEN_KEY = "nazmanwr-github-token";

  /* --- The token -------------------------------------------------------------- */

  function getToken() {
    try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; }
  }

  function setToken(t) {
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* private mode: it lasts as long as the page does */ }
    memoryToken = t;
  }

  var memoryToken = getToken();

  /* --- Talking to GitHub --------------------------------------------------------
     XMLHttpRequest rather than fetch, for one reason: a film is tens of
     megabytes, and only XHR reports upload progress. Without it the screen
     would sit on "Saving…" for a minute with no sign anything is moving.
  -------------------------------------------------------------------------- */

  function api(method, path, body, onProgress) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open(method, path.indexOf("https://") === 0 ? path : API + path);
      xhr.setRequestHeader("Accept", "application/vnd.github+json");
      xhr.setRequestHeader("X-GitHub-Api-Version", "2022-11-28");
      if (memoryToken) xhr.setRequestHeader("Authorization", "Bearer " + memoryToken);
      if (body) xhr.setRequestHeader("Content-Type", "application/json");
      if (onProgress && xhr.upload) {
        xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      }
      xhr.onload = function () {
        var data = null;
        try { data = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (e) { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        var err = new Error(explain(xhr.status, data));
        err.status = xhr.status;
        reject(err);
      };
      xhr.onerror = function () { reject(new Error("no connection to GitHub — check the internet and try again")); };
      xhr.send(body ? JSON.stringify(body) : null);
    });
  }

  function explain(status, data) {
    var said = data && data.message ? data.message : "";
    if (status === 401) return "GitHub did not accept the token. It may have expired — disconnect and paste a new one.";
    if (status === 403 || status === 404) {
      return "the token cannot write to " + REPO + ". It needs Contents: read and write on that repository." +
        (said ? " (GitHub said: " + said + ")" : "");
    }
    return "GitHub refused (" + status + (said ? ": " + said : "") + ")";
  }

  /* --- Reading -------------------------------------------------------------------- */

  function utf8FromBase64(b64) {
    var bin = atob(b64.replace(/\s/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }

  // One consistent picture of the branch: the commit at its tip, and every
  // file path in it with its blob id.
  function snapshot() {
    return api("GET", "/git/ref/heads/" + BRANCH).then(function (ref) {
      var head = ref.object.sha;
      return api("GET", "/git/commits/" + head).then(function (commit) {
        return api("GET", "/git/trees/" + commit.tree.sha + "?recursive=1").then(function (tree) {
          var files = {};
          tree.tree.forEach(function (t) { if (t.type === "blob") files[t.path] = t.sha; });
          return { head: head, tree: commit.tree.sha, files: files };
        });
      });
    });
  }

  function readText(sha) {
    return api("GET", "/git/blobs/" + sha).then(function (b) { return utf8FromBase64(b.content); });
  }

  /* --- Writing ----------------------------------------------------------------------
     One save is one commit, however much is in it: the page, any new pictures
     or films, any removed ones, and the sw.js bump. If someone else commits in
     between — a push from the laptop, say — the page is checked against what
     was loaded, and the save stops rather than overwrite it.
  -------------------------------------------------------------------------- */

  function base64FromBlob(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(",")[1] || ""); };
      r.onerror = function () { reject(new Error("could not read the file to upload it")); };
      r.readAsDataURL(blob);
    });
  }

  function bumpVersion(sw) {
    return sw.replace(/var VERSION = "v(\d+)";/, function (_, n) {
      return 'var VERSION = "v' + (Number(n) + 1) + '";';
    });
  }

  /* opts: {
       page:     "index.html",
       loadedSha: the page's blob id when it was opened,
       html:     the new page,
       uploads:  [{ path, blob, label }],
       remove:   ["assets/…"],
       message:  commit message,
       progress: function (text)
     }
     Resolves with the page's new blob id. */
  function save(opts) {
    var say = opts.progress || function () {};
    var shas = [];

    // Blobs first: they are the slow part and they do not depend on the tip,
    // so a retry after a race does not upload them twice.
    var chain = Promise.resolve();
    (opts.uploads || []).forEach(function (u, i) {
      chain = chain.then(function () {
        say("Preparing " + u.label + "…");
        return base64FromBlob(u.blob);
      }).then(function (b64) {
        var total = (opts.uploads || []).length;
        return api("POST", "/git/blobs", { content: b64, encoding: "base64" }, function (frac) {
          say("Uploading " + u.label + (total > 1 ? " (" + (i + 1) + " of " + total + ")" : "") +
              " — " + Math.round(frac * 100) + "%");
        });
      }).then(function (blob) { shas.push({ path: u.path, sha: blob.sha }); });
    });

    function attempt(tries) {
      say("Checking nothing else has changed…");
      return snapshot().then(function (snap) {
        if (snap.files[opts.page] !== opts.loadedSha) {
          throw new Error("the page was changed somewhere else since you opened this editor. " +
                          "Reload to pick that change up, then make yours again.");
        }
        return readText(snap.files["sw.js"]).then(function (sw) {
          var tree = [
            { path: opts.page, mode: "100644", type: "blob", content: opts.html },
            { path: "sw.js", mode: "100644", type: "blob", content: bumpVersion(sw) }
          ];
          shas.forEach(function (s) { tree.push({ path: s.path, mode: "100644", type: "blob", sha: s.sha }); });
          (opts.remove || []).forEach(function (p) {
            // Deleting a path that is not there is an error, so only real ones go in.
            if (snap.files[p]) tree.push({ path: p, mode: "100644", type: "blob", sha: null });
          });

          say("Saving…");
          return api("POST", "/git/trees", { base_tree: snap.tree, tree: tree });
        }).then(function (tree) {
          return api("POST", "/git/commits", {
            message: opts.message, tree: tree.sha, parents: [snap.head]
          });
        }).then(function (commit) {
          return api("PATCH", "/git/refs/heads/" + BRANCH, { sha: commit.sha, force: false })
            .then(function () { return commit; });
        });
      }).catch(function (err) {
        // 422 here is "not a fast-forward": something landed in the moment
        // between reading the tip and moving it. Worth one more go.
        if (err.status === 422 && tries > 0) return attempt(tries - 1);
        throw err;
      });
    }

    return chain.then(function () { return attempt(1); }).then(function (commit) {
      return api("GET", "/git/trees/" + commit.tree.sha + "?recursive=1").then(function (t) {
        var sha = null;
        t.tree.forEach(function (e) { if (e.path === opts.page) sha = e.sha; });
        return sha;
      });
    });
  }

  /* --- Pictures ---------------------------------------------------------------------
     The same resizing the auction editor does: shrunk here before upload, so a
     5 MB phone photo becomes a few hundred KB, the EXIF rotation is honoured,
     and createImageBitmap is raced against a timer because on some iPads it
     never settles.
  -------------------------------------------------------------------------- */

  var JPEG_QUALITY = 0.82;

  function drawToJpeg(source, w, h, maxEdge) {
    var scale = Math.min(1, maxEdge / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * scale));
    var ch = Math.max(1, Math.round(h * scale));
    var canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    var ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, cw, ch);
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (!blob) return reject(new Error("could not make a JPEG from that picture"));
        resolve({ blob: blob, w: cw, h: ch });
      }, "image/jpeg", JPEG_QUALITY);
    });
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error((file.name || "that file") + " could not be read as a picture"));
      };
      img.src = url;
    });
  }

  function decodeImage(file) {
    if (!window.createImageBitmap) return loadImage(file);
    return new Promise(function (resolve, reject) {
      var settled = false;
      var fallback = function () {
        if (settled) return;
        settled = true;
        loadImage(file).then(resolve, reject);
      };
      var timer = setTimeout(fallback, 4000);
      createImageBitmap(file, { imageOrientation: "from-image" }).then(function (bmp) {
        if (settled) { bmp.close(); return; }
        settled = true;
        clearTimeout(timer);
        resolve(bmp);
      }).catch(function () { clearTimeout(timer); fallback(); });
    });
  }

  // Two sizes from one photograph: the large one the viewer opens, and the
  // small one the grid shows.
  function twoSizes(file, fullEdge, thumbEdge) {
    return decodeImage(file).then(function (src) {
      var w = src.naturalWidth || src.width, h = src.naturalHeight || src.height;
      return drawToJpeg(src, w, h, fullEdge).then(function (full) {
        return drawToJpeg(src, w, h, thumbEdge).then(function (thumb) {
          if (src.close) src.close();
          return { full: full, thumb: thumb };
        });
      });
    });
  }

  /* --- Small things ------------------------------------------------------------------ */

  function pad2(n) { return n < 10 ? "0" + n : String(n); }

  // The next free number in a folder of 01.jpg, 02.jpg… Counted from every
  // file that exists, not just the ones on the page, so a removed picture's
  // number is never handed out again to something else.
  function nextNumber(files, dir) {
    var max = 0;
    var re = new RegExp("^" + dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/(?:full/)?(\\d+)\\.jpg$");
    Object.keys(files).forEach(function (p) {
      var m = re.exec(p);
      if (m) max = Math.max(max, Number(m[1]));
    });
    return max + 1;
  }

  function slug(s) {
    return String(s).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "film";
  }

  function el(tag, props, kids) {
    var e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === "text") e.textContent = props[k];
      else if (k === "on") Object.keys(props.on).forEach(function (ev) { e.addEventListener(ev, props.on[ev]); });
      else if (k in e && k !== "list") e[k] = props[k];
      else e.setAttribute(k, props[k]);
    });
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }

  function message(node, text, kind) {
    node.textContent = text || "";
    node.className = "admin__msg" + (kind ? " is-" + kind : "");
  }

  /* --- The page around an editor ------------------------------------------------------
     boot() shows the connect form until there is a working token, then loads
     the page from the repository and hands its text to the editor. The editor
     calls back with the new page whenever it is asked to save.
  -------------------------------------------------------------------------- */

  function boot(cfg) {
    var connect = document.getElementById("connect");
    var editor = document.getElementById("editor");
    var bar = document.getElementById("savebar");
    var barText = document.getElementById("savebar-text");
    var saveBtn = document.getElementById("save");
    var discardBtn = document.getElementById("discard");
    var msg = document.getElementById("save-msg");
    var state = { sha: null, html: "", files: {}, dirty: false, busy: false };

    function showConnect(note, kind) {
      editor.hidden = true;
      bar.hidden = true;
      connect.hidden = false;
      message(document.getElementById("connect-msg"), note, kind);
    }

    // A note to show once the page has reloaded — the word that a save worked.
    function load(note) {
      message(msg, note || "", note ? "done" : null);
      editor.hidden = false;
      connect.hidden = true;
      cfg.loading(true);
      return snapshot().then(function (snap) {
        if (!snap.files[cfg.page]) throw new Error(cfg.page + " is not in the repository");
        state.files = snap.files;
        state.sha = snap.files[cfg.page];
        return readText(state.sha);
      }).then(function (html) {
        state.html = html;
        state.dirty = false;
        cfg.loading(false);
        cfg.loaded(html, state.files);
        refreshBar();
      }).catch(function (err) {
        cfg.loading(false);
        if (err.status === 401 || err.status === 403 || err.status === 404) {
          showConnect(err.message, "error");
        } else {
          message(msg, "Could not load the page: " + err.message, "error");
        }
      });
    }

    function refreshBar() {
      bar.hidden = !state.dirty && !state.busy;
      if (!state.busy) barText.textContent = "Changes not published yet";
      saveBtn.disabled = state.busy || !state.dirty;
      discardBtn.disabled = state.busy;
    }

    document.getElementById("connect-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var t = document.getElementById("connect-token").value.trim();
      if (!t) return;
      setToken(t);
      message(document.getElementById("connect-msg"), "Checking…");
      api("GET", "").then(function (repo) {
        if (!repo.permissions || !repo.permissions.push) {
          setToken("");
          throw new Error("that token can read the repository but not write to it. " +
                          "Give it Contents: read and write.");
        }
        document.getElementById("connect-token").value = "";
        return load();
      }).catch(function (err) {
        setToken("");
        showConnect(err.message, "error");
      });
    });

    var out = document.getElementById("disconnect");
    if (out) out.addEventListener("click", function () {
      if (state.dirty && !confirm("You have changes that are not published. Disconnect anyway?")) return;
      setToken("");
      showConnect("Disconnected. This device no longer has the token.", "done");
    });

    discardBtn.addEventListener("click", function () {
      if (!confirm("Throw away the changes you have not published?")) return;
      load();
    });

    saveBtn.addEventListener("click", function () {
      var plan;
      try { plan = cfg.build(state.html, state.files); } catch (err) {
        message(msg, err.message, "error");
        return;
      }
      state.busy = true;
      refreshBar();
      message(msg, "");
      save({
        page: cfg.page,
        loadedSha: state.sha,
        html: plan.html,
        uploads: plan.uploads,
        remove: plan.remove,
        message: plan.message,
        progress: function (t) { barText.textContent = t; }
      }).then(function () {
        state.busy = false;
        return load("Published. The live page updates in about a minute.");
      }).catch(function (err) {
        state.busy = false;
        refreshBar();
        message(msg, "Not published: " + err.message, "error");
      });
    });

    window.addEventListener("beforeunload", function (e) {
      if (state.dirty || state.busy) { e.preventDefault(); e.returnValue = ""; }
    });

    if (memoryToken) load(); else showConnect("");

    return {
      // The editor says something moved; whether anything is actually different
      // is worked out by writing the page and comparing, so undoing an edit by
      // hand clears the bar again.
      changed: function () { state.dirty = !!cfg.dirty(state.html); refreshBar(); message(msg, ""); },
      files: function () { return state.files; }
    };
  }

  window.SiteAdmin = {
    boot: boot,
    twoSizes: twoSizes,
    nextNumber: nextNumber,
    pad2: pad2,
    slug: slug,
    el: el,
    message: message,
    _bumpVersion: bumpVersion
  };
})();
