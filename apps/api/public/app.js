// Agent Skill Depot — tiny progressive-enhancement helpers.
// Served from /public/app.js, loaded deferred. No dependencies.
// Every interaction here degrades gracefully if JS is disabled.

(function () {
  "use strict";

  // --- Copy-to-clipboard --------------------------------------------------
  // Buttons opt in with `data-copy="text to copy"` (or data-copy-target="#id"
  // to copy the textContent of another element). On click we write to the
  // clipboard and briefly swap the button label for feedback.
  function onCopyClick(e) {
    var btn = e.currentTarget;
    var text = btn.getAttribute("data-copy");
    if (!text) {
      var sel = btn.getAttribute("data-copy-target");
      if (sel) {
        var el = document.querySelector(sel);
        if (el) text = el.textContent || "";
      }
    }
    if (!text) return;
    var original = btn.getAttribute("data-copy-label") || btn.textContent;
    if (!btn.getAttribute("data-copy-label")) {
      btn.setAttribute("data-copy-label", original);
    }
    var done = function () {
      btn.textContent = "Copied ✓";
      setTimeout(function () {
        btn.textContent = btn.getAttribute("data-copy-label") || original;
      }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () {
        // Fallback: user can manually select the adjacent <code> block.
      });
    }
  }

  function wireCopyButtons() {
    var btns = document.querySelectorAll("[data-copy], [data-copy-target]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", onCopyClick);
    }
  }

  // --- Share profile ------------------------------------------------------
  // `<button data-share-url>` copies window.location.href. Uses the Web
  // Share API on mobile when available, otherwise falls back to clipboard.
  function onShareClick(e) {
    var btn = e.currentTarget;
    var url = btn.getAttribute("data-share-url") || window.location.href;
    if (navigator.share) {
      navigator.share({ url: url, title: document.title }).catch(function () {});
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () {
        var original = btn.getAttribute("data-share-label") || btn.textContent;
        if (!btn.getAttribute("data-share-label")) {
          btn.setAttribute("data-share-label", original);
        }
        btn.textContent = "Link copied ✓";
        setTimeout(function () {
          btn.textContent = btn.getAttribute("data-share-label") || original;
        }, 1400);
      });
    }
  }

  function wireShareButtons() {
    var btns = document.querySelectorAll("[data-share-url]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener("click", onShareClick);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      wireCopyButtons();
      wireShareButtons();
    });
  } else {
    wireCopyButtons();
    wireShareButtons();
  }
})();
