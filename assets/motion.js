/* 界面动效：选项指示条滑动、列表进场与重排、视图淡入、按压回弹、数字滚动 */
(function () {
  "use strict";
  var RM = window.matchMedia ? matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  var CAN = typeof Element !== "undefined" && "animate" in Element.prototype && window.CSS && CSS.supports && CSS.supports("translate", "1px");
  var EASE = "cubic-bezier(.22,.8,.24,1)";
  var cfg = null;
  var queued = false, themeDirty = false;
  var indMemo = new Map();
  var listKeys = new Map();
  var rectCache = null, rectTime = 0;
  var viewState = new WeakMap();
  var numState = new WeakMap();
  var numBusy = new WeakSet();
  var sizeObs = null;

  function still() { return RM.matches || !CAN; }
  function arr(x) { return Array.prototype.slice.call(x || []); }
  function each(sel, fn) { if (sel) arr(document.querySelectorAll(sel)).forEach(fn); }

  /* ---------- 选项指示条 ---------- */
  function activeOf(host, t) {
    if (t.deep) return host.querySelector(t.item + t.active);
    var kids = arr(host.children);
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k.classList.contains("m-ind")) continue;
      if (t.item && !k.matches(t.item)) continue;
      if (k.matches(t.active)) return k;
    }
    return null;
  }

  function probe(host, act, t) {
    host.classList.add("m-probe");
    host.classList.remove("m-ind-host");
    var deep = host.classList.contains("m-deep-host");
    if (deep) host.classList.remove("m-deep-host");
    var s = {};
    if (t.mode === "bar") {
      s.bg = getComputedStyle(act).color;
      s.h = t.h || 3;
      s.radius = "3px";
    } else if (t.mode === "line") {
      var p = getComputedStyle(act, t.pseudo || "::after");
      s.bg = p.backgroundColor;
      if (!s.bg || s.bg === "rgba(0, 0, 0, 0)") s.bg = p.borderBottomColor;
      s.h = parseFloat(p.height) || 2;
      s.l = parseFloat(p.left) || 0;
      s.r = parseFloat(p.right) || 0;
      s.b = parseFloat(p.bottom);
      if (isNaN(s.b)) s.b = 0;
      s.radius = p.borderRadius;
    } else {
      var c = getComputedStyle(act);
      s.bg = c.backgroundColor;
      s.radius = c.borderRadius;
      s.shadow = c.boxShadow;
      s.bw = c.borderTopWidth;
      s.bc = c.borderTopColor;
      s.bs = c.borderTopStyle;
    }
    host.classList.add("m-ind-host");
    if (deep) host.classList.add("m-deep-host");
    void host.offsetWidth;
    host.classList.remove("m-probe");
    return s;
  }

  function placeTab(host, t, key) {
    if (!host.isConnected) return;
    var act = activeOf(host, t);
    var ind = host._mInd;
    if (!ind || ind.parentNode !== host) {
      ind = document.createElement("span");
      ind.className = "m-ind" + (t.mode === "line" || t.mode === "bar" ? " m-ind-line" : "");
      ind.setAttribute("aria-hidden", "true");
      host.insertBefore(ind, host.firstChild);
      host._mInd = ind;
      host._mGeo = indMemo.get(key) || null;
      host._mAct = null;
      if (getComputedStyle(host).position === "static") host.classList.add("m-rel");
      host.classList.add("m-ind-host");
      if (t.mode === "line") host.classList.add("m-line-host");
      if (t.deep) host.classList.add("m-deep-host");
      if (sizeObs) sizeObs.observe(host);
    }
    if (!act || !act.offsetWidth) {
      if (!act) { ind.style.opacity = "0"; if (host._mAct) host._mAct.classList.remove("m-act"); host._mAct = null; }
      return;
    }
    if (host._mAct !== act || themeDirty || !host._mStyle) {
      if (host._mAct && host._mAct !== act) host._mAct.classList.remove("m-act");
      act.classList.remove("m-act");
      host._mStyle = probe(host, act, t);
      act.classList.add("m-act");
      host._mAct = act;
      var s = host._mStyle;
      ind.style.backgroundColor = s.bg;
      ind.style.borderRadius = s.radius;
      if (t.mode !== "line" && t.mode !== "bar") {
        ind.style.boxShadow = s.shadow && s.shadow !== "none" ? s.shadow : "";
        ind.style.border = parseFloat(s.bw) > 0 && s.bs !== "none" ? s.bw + " " + s.bs + " " + s.bc : "0";
      }
    }
    var s2 = host._mStyle;
    var g, ox = act.offsetLeft, oy = act.offsetTop;
    if (act.offsetParent !== host) {
      var ra = act.getBoundingClientRect(), rh = host.getBoundingClientRect();
      ox = Math.round(ra.left - rh.left - host.clientLeft + host.scrollLeft);
      oy = Math.round(ra.top - rh.top - host.clientTop + host.scrollTop);
    }
    if (t.mode === "bar") {
      var bw = t.w || 20;
      g = { x: ox + (act.offsetWidth - bw) / 2, y: t.pos === "bottom" ? oy + act.offsetHeight - s2.h : oy + (t.top || 0), w: bw, h: s2.h };
    } else if (t.mode === "line") {
      g = { x: ox + s2.l, y: oy + act.offsetHeight - s2.b - s2.h, w: Math.max(4, act.offsetWidth - s2.l - s2.r), h: s2.h };
    } else {
      g = { x: ox, y: oy, w: act.offsetWidth, h: act.offsetHeight };
    }
    var prev = host._mGeo;
    if (prev && ind._mPlaced && prev.x === g.x && prev.y === g.y && prev.w === g.w && prev.h === g.h && ind.style.opacity === "1") return;
    if (!ind._mPlaced || still()) {
      setGeo(ind, still() ? g : prev || g);
      ind.style.transition = "none";
      void ind.offsetWidth;
      ind.style.transition = "";
      ind._mPlaced = true;
    }
    setGeo(ind, g);
    ind.style.opacity = "1";
    host._mGeo = g;
    indMemo.set(key, g);
  }

  function setGeo(ind, g) {
    ind.style.transform = "translate(" + g.x + "px," + g.y + "px)";
    ind.style.width = g.w + "px";
    ind.style.height = g.h + "px";
  }

  function scope() { try { return cfg.scope ? cfg.scope() : ""; } catch (e) { return ""; } }

  function scanTabs() {
    (cfg.tabs || []).forEach(function (t, ti) {
      arr(document.querySelectorAll(t.host)).forEach(function (host, hi) {
        placeTab(host, t, scope() + ":" + ti + ":" + (host.id || hi));
      });
    });
  }

  /* ---------- 列表进场与重排 ---------- */
  function keyOf(el, l) { return l.key ? el.getAttribute(l.key) : null; }

  function cacheRects() {
    if (still() || !cfg.lists) return;
    var m = new Map(), vh = innerHeight;
    cfg.lists.forEach(function (l) {
      if (!l.key) return;
      each(l.sel, function (c) {
        if (!c.offsetParent && getComputedStyle(c).position !== "fixed") return;
        arr(c.querySelectorAll(l.item)).some(function (el) {
          var r = el.getBoundingClientRect();
          if (r.bottom < -40) return false;
          if (r.top > vh + 40) return true;
          var k = el.getAttribute(l.key);
          if (k) m.set(l.sel + "|" + k, r);
          return false;
        });
      });
    });
    rectCache = m;
    rectTime = Date.now();
  }

  function runLists() {
    if (!cfg.lists) return;
    var vh = innerHeight, fresh = rectCache && Date.now() - rectTime < 1500;
    cfg.lists.forEach(function (l) {
      var seen = listKeys.get(l.sel);
      var now = new Set(), i = 0, stag = l.stagger == null ? 30 : l.stagger, cap = l.cap || 10;
      each(l.sel, function (c) {
        arr(c.querySelectorAll(l.item)).forEach(function (el) {
          var k = keyOf(el, l);
          if (k) now.add(k);
          if (el._mSeen) return;
          el._mSeen = true;
          if (still() || !el.isConnected) return;
          var r = el.getBoundingClientRect();
          if (r.bottom < 0 || r.top > vh || !r.width) return;
          if (k && seen && seen.has(k)) {
            var old = fresh && rectCache.get(l.sel + "|" + k);
            if (!old) return;
            var dx = old.left - r.left, dy = old.top - r.top;
            if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
            if (Math.abs(dy) > vh) return;
            el.animate([{ translate: dx + "px " + dy + "px" }, { translate: "0 0" }], { duration: 320, easing: EASE });
          } else {
            el.animate(
              [{ opacity: 0, translate: "0 " + (l.dy || 10) + "px" }, { opacity: 1, translate: "0 0" }],
              { duration: l.duration || 300, delay: Math.min(i, cap) * stag, easing: EASE, fill: "backwards" }
            );
            i++;
          }
        });
      });
      if (now.size || !seen) listKeys.set(l.sel, now);
    });
    if (fresh) rectCache = null;
  }

  var pageArmed = true;
  function runPage() {
    if (!cfg.page || !pageArmed) return;
    var c = document.querySelector(cfg.page);
    if (!c || !c.children.length) return;
    pageArmed = false;
    if (still()) return;
    arr(c.children).slice(0, cfg.pageCap || 8).forEach(function (el, i) {
      el.animate([{ opacity: 0, translate: "0 10px" }, { opacity: 1, translate: "0 0" }], { duration: 300, delay: i * 40, easing: EASE, fill: "backwards" });
    });
  }

  /* ---------- 视图切换 ---------- */
  function shown(el) {
    if (el.hidden) return false;
    var cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden";
  }

  function runViews() {
    if (!cfg.views) return;
    each(cfg.views, function (v) {
      var on = shown(v), was = viewState.get(v);
      viewState.set(v, on);
      if (on && was === false && !still()) {
        v.animate([{ opacity: 0 }, { opacity: 1 }], { duration: cfg.viewDuration || 240, easing: "ease-out" });
        if (cfg.viewChildren) {
          arr(v.querySelectorAll(cfg.viewChildren)).slice(0, 8).forEach(function (c, i) {
            c.animate([{ opacity: 0, translate: "0 8px" }, { opacity: 1, translate: "0 0" }], { duration: 280, delay: i * 35, easing: EASE, fill: "backwards" });
          });
        }
      }
    });
  }

  /* ---------- 数字滚动 ---------- */
  var NUM = /\d[\d,]*(?:\.\d+)?/g;
  function runCounters() {
    if (!cfg.counters) return;
    each(cfg.counters, function (el) {
      if (numBusy.has(el)) return;
      if (el.children.length) {
        arr(el.children).forEach(function (c) { if (!c.children.length) countOne(c); });
        return;
      }
      countOne(el);
    });
  }
  function runCountUp() {
    if (!cfg.countUp) return;
    each(cfg.countUp, function (el) {
      if (numBusy.has(el) || el.children.length) return;
      var r = el.getBoundingClientRect();
      var vis = r.width > 0 && r.bottom > 0 && r.top < innerHeight;
      var was = el._mVis;
      el._mVis = vis;
      if (!vis || was) return;
      var txt = el.textContent;
      NUM.lastIndex = 0;
      if (!NUM.test(txt)) return;
      NUM.lastIndex = 0;
      numState.set(el, txt.replace(NUM, "0"));
      countOne(el, true);
    });
  }

  var growMemo = new Map();
  function runGrow() {
    if (!cfg.grow) return;
    arr(document.querySelectorAll(cfg.grow)).forEach(function (el, i) {
      if (el._mGrown) return;
      el._mGrown = true;
      var w = el.style.width;
      if (!w || w.indexOf("%") < 0) return;
      var k = scope() + ":" + i, prev = growMemo.get(k);
      growMemo.set(k, w);
      if (still() || prev === w) return;
      el.animate([{ width: prev || "0%" }, { width: w }], { duration: 520, easing: EASE });
    });
  }

  function countOne(el, force) {
    if (numBusy.has(el)) return;
    var txt = el.textContent, old = numState.get(el);
    numState.set(el, txt);
    if (old == null || old === txt || still()) return;
    if (!force && cfg.countUp && el.matches && el.matches(cfg.countUp) && !el._mVis) return;
    var a = old.match(NUM), b = txt.match(NUM);
    if (!a || !b || a.length !== b.length) return;
    if (old.replace(NUM, "#") !== txt.replace(NUM, "#")) return;
    var from = a.map(function (s) { return parseFloat(s.replace(/,/g, "")); });
    var to = b.map(function (s) { return parseFloat(s.replace(/,/g, "")); });
    var dec = b.map(function (s) { var m = s.split(".")[1]; return m ? m.length : 0; });
    var comma = b.map(function (s) { return s.indexOf(",") >= 0; });
    var parts = txt.split(NUM);
    var t0 = performance.now(), dur = 420;
    numBusy.add(el);
    function fmt(v, j) {
      var s = v.toFixed(dec[j]);
      return comma[j] ? s.replace(/\B(?=(\d{3})+(?!\d))/g, ",") : s;
    }
    function frame(t) {
      if (el.textContent !== cur) { numBusy.delete(el); numState.set(el, el.textContent); return; }
      var p = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      var out = "", k = 0;
      var segs = txt.match(NUM);
      for (var j = 0; j < parts.length; j++) {
        out += parts[j];
        if (j < segs.length) { out += p >= 1 ? segs[j] : fmt(from[k] + (to[k] - from[k]) * e, k); k++; }
      }
      el.textContent = out;
      cur = out;
      if (p < 1) requestAnimationFrame(frame);
      else { numBusy.delete(el); numState.set(el, txt); }
    }
    var cur = el.textContent;
    requestAnimationFrame(frame);
  }

  /* ---------- 按压与回弹 ---------- */
  var PRESS = "button, [role=button], [role=tab], .btn, summary, label.chip, a.chip";
  var pressed = null;
  function pressable(el) {
    if (!el || el.disabled || el.getAttribute("aria-disabled") === "true") return false;
    if (cfg.noPress && el.matches(cfg.noPress)) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.width < 360 && r.height < 120;
  }
  function onDown(e) {
    if (e.button || still()) return;
    cacheRects();
    var el = e.target.closest && e.target.closest(cfg.press || PRESS);
    if (!pressable(el)) return;
    pressed = el;
    el._mAnim && el._mAnim.cancel();
    el._mAnim = el.animate([{ scale: 1 }, { scale: cfg.pressScale || 0.95 }], { duration: 110, easing: "ease-out", fill: "forwards" });
  }
  function release(el, pop) {
    if (!el) return;
    el._mAnim && el._mAnim.cancel();
    el._mAnim = el.animate(pop ? [{ scale: 0.92 }, { scale: 1.06 }, { scale: 1 }] : [{ scale: cfg.pressScale || 0.95 }, { scale: 1.02 }, { scale: 1 }], { duration: pop ? 320 : 260, easing: EASE });
  }
  function onUp() {
    var el = pressed;
    pressed = null;
    if (el && el.isConnected) release(el);
  }
  function signature(el) {
    var sel = el.tagName.toLowerCase();
    var n = 0;
    arr(el.attributes).forEach(function (a) {
      if (/^data-/.test(a.name) && a.value.length < 80) { sel += "[" + a.name + '="' + a.value.replace(/["\\]/g, "\\$&") + '"]'; n++; }
    });
    if (!n && el.id) sel = "#" + CSS.escape(el.id);
    else if (!n && el.tagName === "A" && el.getAttribute("href") && el.getAttribute("href").length < 160) sel = 'a[href="' + el.getAttribute("href").replace(/["\\]/g, "\\$&") + '"]';
    else if (!n) return null;
    return sel;
  }
  function onClick(e) {
    if (still()) return;
    var el = e.target.closest && e.target.closest(cfg.press || PRESS);
    if (!el) return;
    var sig = signature(el);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        if (el.isConnected || !sig) return;
        var n;
        try { n = document.querySelector(sig); } catch (x) { return; }
        if (n && pressable(n)) release(n, true);
      });
    });
  }

  /* ---------- 深浅色切换 ---------- */
  var themeTimer = 0;
  function themeShift() {
    themeDirty = true;
    if (still() || document.querySelectorAll("*").length > 6000) return;
    var r = document.documentElement;
    r.classList.add("m-theming");
    clearTimeout(themeTimer);
    themeTimer = setTimeout(function () { r.classList.remove("m-theming"); }, 420);
  }

  /* ---------- 调度 ---------- */
  function flush() {
    queued = false;
    try { scanTabs(); } catch (e) {}
    try { runViews(); } catch (e) {}
    try { runPage(); } catch (e) {}
    try { runLists(); } catch (e) {}
    try { runCounters(); } catch (e) {}
    try { runCountUp(); } catch (e) {}
    try { runGrow(); } catch (e) {}
    themeDirty = false;
  }
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(flush);
  }

  function init(c) {
    cfg = c || {};
    var root = document.documentElement;
    root.classList.add("m-on");
    var lastTheme = themeSig();
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (m.target === root || m.target === document.body) {
          if (m.type === "attributes" && m.attributeName !== "style") {
            var s = themeSig();
            if (s !== lastTheme) { lastTheme = s; themeShift(); }
          }
        }
        if (m.type === "attributes" && m.target.classList && m.target.classList.contains("m-ind")) continue;
        var tg = m.target.nodeType === 3 ? m.target.parentNode : m.target;
        if (tg && numBusy.has(tg)) continue;
        schedule();
        return;
      }
    }).observe(root, { subtree: true, childList: true, attributes: true, characterData: true, attributeFilter: ["class", "hidden", "aria-pressed", "aria-selected", "aria-current", "aria-checked", "data-theme", "data-size", "style", "open"] });
    if (window.ResizeObserver) sizeObs = new ResizeObserver(schedule);
    addEventListener("resize", schedule);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointerup", onUp, true);
    document.addEventListener("pointercancel", onUp, true);
    document.addEventListener("click", onClick, true);
    if (cfg.keyCache !== false) document.addEventListener("keydown", function (e) { if (!e.repeat && !/^(INPUT|TEXTAREA)$/.test(e.target.tagName || "")) cacheRects(); }, true);
    addEventListener("hashchange", function () {
      if (cfg.routeReset) { listKeys.clear(); rectCache = null; } else cacheRects();
      pageArmed = true;
      schedule();
    }, true);
    document.addEventListener("change", cacheRects, true);
    document.addEventListener("input", function (e) { if (e.target && e.target.type === "search") cacheRects(); }, true);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
    if (cfg.views) each(cfg.views, function (v) { viewState.set(v, shown(v)); });
    schedule();
  }
  function themeSig() {
    var r = document.documentElement, b = document.body, out = [];
    [r, b].forEach(function (el) {
      if (!el) return;
      out.push(el.getAttribute("data-theme") || "", el.getAttribute("data-mode") || "");
      out.push((el.className.match(/\b[\w-]*(dark|light|theme|night)[\w-]*\b/gi) || []).join(" "));
    });
    return out.join("|");
  }

  window.Motion = { init: init, refresh: schedule, cacheRects: cacheRects };
})();

Motion.init({
  keyCache: false,
  tabs: [
    { host: ".seg", item: "button", active: ".on" },
    { host: "#bookList", item: ".bl-item", active: ".on" },
    { host: "#chapterGrid", item: ".ch-chip", active: ".sel" }
  ],
  lists: [
    { sel: "#mistakeList", item: ":scope > .mk", cap: 8 },
    { sel: "#chapterPreview", item: ".pv-item", cap: 12, stagger: 18 },
    { sel: "#sumWords", item: ":scope > *", cap: 12, stagger: 25 }
  ],
  counters: "#stWpm, #mistakeBadge",
  countUp: "#sumAcc, #sumWpm, #sumWrong",
  grow: ".bl-bar i"
});
