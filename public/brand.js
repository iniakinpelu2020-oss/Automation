// Apex Automation — single source of truth for the product name shown in the UI.
// The compiled bundle still contains the old label text in two places (the auth
// card heading and the sidebar header), so we rewrite those two exact labels
// after each render instead of duplicating the name across the app.
(function () {
  var APP_NAME = "Apex Automation";
  var OLD_HEADING = "Automation Builder";
  var OLD_SIDEBAR = "Automation";

  function retitle(el, from) {
    if (!el) return;
    var text = (el.textContent || "").trim();
    if (text === from) el.textContent = APP_NAME;
  }

  function apply(root) {
    if (!root || root.nodeType !== 1) return;
    try {
      var headings = root.matches && root.matches("h1")
        ? [root]
        : Array.prototype.slice.call(root.querySelectorAll ? root.querySelectorAll("h1") : []);
      for (var i = 0; i < headings.length; i++) retitle(headings[i], OLD_HEADING);

      var sidebar = root.matches && root.matches(".sidebar .font-semibold")
        ? [root]
        : Array.prototype.slice.call(root.querySelectorAll ? root.querySelectorAll(".sidebar .font-semibold") : []);
      for (var j = 0; j < sidebar.length; j++) retitle(sidebar[j], OLD_SIDEBAR);
    } catch (e) {
      /* branding must never break the app */
    }
  }

  function start() {
    apply(document.body);
    try {
      var observer = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var added = records[i].addedNodes || [];
          for (var j = 0; j < added.length; j++) apply(added[j]);
          if (records[i].type === "characterData") apply(records[i].target.parentElement);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    } catch (e) {
      /* ignore */
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
