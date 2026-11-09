(function () {
  'use strict';

  /* ================= data ================= */
  var DATA = window.CIYUN_DATA || { words: [], books: [] };
  var WORDS = DATA.words;
  var BOOKS = DATA.books;
  var BOOK_MAP = {};
  BOOKS.forEach(function (b) { BOOK_MAP[b.id] = b; });
  var KEY_INDEX = {};
  WORDS.forEach(function (w, i) { var k = w.w.toLowerCase(); if (!(k in KEY_INDEX)) KEY_INDEX[k] = i; });

  /* ================= storage ================= */
  var NS = 'ciyun.v1.';
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem(NS + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem(NS + k, JSON.stringify(v)); } catch (e) { /* quota / private mode */ } }
  };
  var DEFAULTS = {
    accent: 'us', autoPlay: true, volume: 80, keySound: false, mode: 'normal', showPhonetic: true,
    showWord: false, showExtras: true, wrongMode: 'block', repeat: 1, chapterSize: 20
  };
  var settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
  var stats = store.get('stats', {});        // word(lower) -> {a, e, h, c, t, m}
  var mistakes = store.get('mistakes', {});  // word(lower) -> {t, e, h, s}
  var progress = store.get('progress', { book: 'all', books: {} });
  var records = store.get('records', {});    // bookId -> layoutKey -> chapterIdx -> {acc,wpm,time,wrong,ts}

  function save(which) {
    if (!which || which === 'settings') store.set('settings', settings);
    if (!which || which === 'stats') store.set('stats', stats);
    if (!which || which === 'mistakes') store.set('mistakes', mistakes);
    if (!which || which === 'progress') store.set('progress', progress);
    if (!which || which === 'records') store.set('records', records);
  }

  /* ================= helpers ================= */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmtTime(ms) { var s = Math.floor(ms / 1000); var m = Math.floor(s / 60); s = s % 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s; }
  function keyOf(i) { return WORDS[i].w.toLowerCase(); }
  function mulberry(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function shuffled(arr, seed) { var a = arr.slice(), r = mulberry(seed); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function meanText(w, max) {
    var s = w.m.map(function (m) { return (m[0] && m[0] !== 'phr.' ? m[0] + ' ' : '') + m[1]; }).join('  ');
    return max && s.length > max ? s.slice(0, max) + '…' : s;
  }
  var toastTimer;
  function toast(msg, ms) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 1800);
  }

  /* ================= books & chapters ================= */
  function bookState(id) {
    var b = progress.books[id];
    if (!b) { b = progress.books[id] = { order: 'alpha', seed: 1 + Math.floor(Math.random() * 1e9), chapter: 0, pos: 0 }; }
    return b;
  }
  function orderedIds(id) {
    var book = BOOK_MAP[id]; var st = bookState(id);
    return st.order === 'random' ? shuffled(book.ids, st.seed) : book.ids;
  }
  function chaptersOf(id) {
    var ids = orderedIds(id), size = +settings.chapterSize, out = [];
    for (var i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
    return out;
  }
  function layoutKey(id) { var st = bookState(id); return settings.chapterSize + '|' + st.order + (st.order === 'random' ? '|' + st.seed : ''); }
  function chapterRecords(id) { var r = records[id] || (records[id] = {}); return r[layoutKey(id)] || (r[layoutKey(id)] = {}); }
  function learnedCount(ids) { var n = 0; for (var i = 0; i < ids.length; i++) { var s = stats[keyOf(ids[i])]; if (s && s.a) n++; } return n; }
  function mistakeKeys() { return Object.keys(mistakes).filter(function (k) { return k in KEY_INDEX; }); }

  /* ================= audio ================= */
  var audioCache = new Map();
  var audioFails = 0;
  var speakSeq = 0;
  var ttsVoices = [];
  function loadVoices() { try { ttsVoices = window.speechSynthesis ? speechSynthesis.getVoices() : []; } catch (e) { ttsVoices = []; } }
  if (window.speechSynthesis) { loadVoices(); speechSynthesis.onvoiceschanged = loadVoices; }
  function audioUrl(word) { return 'https://dict.youdao.com/dictvoice?audio=' + encodeURIComponent(word) + '&type=' + (settings.accent === 'uk' ? 1 : 2); }
  function getAudio(word) {
    var url = audioUrl(word), a = audioCache.get(url);
    if (!a) {
      a = new Audio(); a.preload = 'auto'; a.src = url;
      audioCache.set(url, a);
      if (audioCache.size > 40) { var first = audioCache.keys().next().value; audioCache.delete(first); }
    }
    return a;
  }
  function prefetch(word) { if (audioFails < 3) getAudio(word); }
  function speakerUI(on) { $('#btnSpeak').classList.toggle('playing', !!on); }
  function tts(word) {
    if (!window.speechSynthesis) { speakerUI(false); return; }
    try {
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(word);
      var lang = settings.accent === 'uk' ? 'en-GB' : 'en-US';
      u.lang = lang; u.rate = 0.9; u.volume = settings.volume / 100;
      var v = ttsVoices.filter(function (x) { return x.lang && x.lang.replace('_', '-') === lang; })[0] || ttsVoices.filter(function (x) { return /^en/.test(x.lang); })[0];
      if (v) u.voice = v;
      u.onstart = function () { speakerUI(true); };
      u.onend = u.onerror = function () { speakerUI(false); };
      speechSynthesis.speak(u);
    } catch (e) { speakerUI(false); }
  }
  function speak(word) {
    if (!word || settings.volume === 0) return;
    var seq = ++speakSeq;
    if (audioFails >= 3) { tts(word); return; }
    var a = getAudio(word), started = false, settled = false;
    audioCache.forEach(function (x) { if (x !== a) { try { x.pause(); } catch (e) {} } });
    if (window.speechSynthesis) try { speechSynthesis.cancel(); } catch (e) {}
    a.volume = settings.volume / 100;
    try { a.currentTime = 0; } catch (e) {}
    var fallback = function () {
      if (settled || seq !== speakSeq) return; settled = true;
      audioFails++; audioCache.delete(audioUrl(word)); tts(word);
    };
    var timer = setTimeout(function () { if (!started) fallback(); }, 2600);
    a.onplaying = function () { started = true; settled = true; audioFails = 0; clearTimeout(timer); if (seq === speakSeq) speakerUI(true); };
    a.onended = a.onpause = function () { if (seq === speakSeq) speakerUI(false); };
    a.onerror = function () { clearTimeout(timer); fallback(); };
    var p = a.play();
    if (p && p.catch) p.catch(function (err) {
      clearTimeout(timer);
      if (err && err.name === 'NotAllowedError') { settled = true; speakerUI(false); toast('浏览器阻止了自动播放，点击听筒即可发音'); }
      else fallback();
    });
  }

  /* soft key sounds (Web Audio) */
  var actx = null;
  function blip(type) {
    if (!settings.keySound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      var o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
      o.type = type === 'bad' ? 'triangle' : 'sine';
      o.frequency.setValueAtTime(type === 'bad' ? 180 : type === 'done' ? 880 : 620, t);
      if (type === 'done') o.frequency.exponentialRampToValueAtTime(1320, t + 0.12);
      var vol = (settings.volume / 100) * (type === 'key' ? 0.05 : 0.08);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + (type === 'done' ? 0.22 : 0.08));
      o.connect(g); g.connect(actx.destination); o.start(t); o.stop(t + 0.25);
    } catch (e) {}
  }

  /* ================= session ================= */
  var S = null;   // current session
  var W = null;   // current word typing state
  var started = false, paused = false, locked = false;

  function newSession(type, list, meta) {
    S = {
      type: type, list: list, pos: 0, meta: meta || {},
      results: {}, keys: 0, good: 0, active: 0, lastKey: 0, done: 0, startTs: Date.now()
    };
  }
  function startChapter(bookId, idx, pos) {
    var chs = chaptersOf(bookId);
    if (!chs.length) return;
    idx = Math.max(0, Math.min(idx, chs.length - 1));
    progress.book = bookId;
    var st = bookState(bookId); st.chapter = idx; st.pos = pos || 0; save('progress');
    newSession('chapter', chs[idx], { book: bookId, chapter: idx, total: chs.length });
    S.pos = Math.min(pos || 0, S.list.length - 1);
    renderHeader(); loadWord();
  }
  function startMistakes(keys, label) {
    var ids = keys.map(function (k) { return KEY_INDEX[k]; }).filter(function (i) { return i != null; });
    if (!ids.length) { toast('错词本是空的，继续保持'); return false; }
    var from = S && S.type === 'chapter' ? { book: S.meta.book, chapter: S.meta.chapter } : (S && S.meta.from) || null;
    newSession('mistakes', shuffled(ids, Date.now() & 0xffffff), { label: label || '错词练习', from: from });
    renderHeader(); loadWord();
    return true;
  }
  function exitMistakes() {
    var f = S && S.meta.from;
    var st = bookState(progress.book);
    if (f) startChapter(f.book, f.chapter, bookState(f.book).pos);
    else startChapter(progress.book, st.chapter, st.pos);
  }

  function curIdx() { return S.list[S.pos]; }
  function curWord() { return WORDS[curIdx()]; }

  function loadWord(dir) {
    var w = curWord();
    W = { target: w.w, typed: '', bad: '', errors: 0, roundErrors: 0, hint: false, round: 0, revealUntil: 0 };
    var card = $('#card');
    card.classList.remove('leaving');
    if (dir) { card.classList.add('entering'); requestAnimationFrame(function () { requestAnimationFrame(function () { card.classList.remove('entering'); }); }); }
    renderCard();
    renderStats();
    if (S.type === 'chapter') { var st = bookState(S.meta.book); st.pos = S.pos; save('progress'); }
    if (started && settings.autoPlay && !paused) speak(w.w);
    var nx = S.list[S.pos + 1]; if (nx != null) prefetch(WORDS[nx].w);
  }

  /* ================= rendering ================= */
  function renderHeader() {
    var tag = $('#sessionTag'); tag.innerHTML = '';
    if (S.type === 'mistakes') {
      var t = el('span', 'tag', S.meta.label + ' · ' + S.list.length + ' 词'); tag.appendChild(t);
      var x = el('button', 'exit', '返回章节'); x.onclick = exitMistakes; tag.appendChild(x);
      $('#bpBook').textContent = S.meta.label; $('#bpChap').textContent = S.list.length + ' 词';
    } else {
      var b = BOOK_MAP[S.meta.book];
      $('#bpBook').textContent = b.name;
      $('#bpChap').textContent = '第 ' + (S.meta.chapter + 1) + ' / ' + S.meta.total + ' 章';
      if (bookState(S.meta.book).order === 'random') { tag.appendChild(el('span', 'tag blue', '乱序')); }
    }
    $('#btnMode').classList.toggle('active', settings.mode === 'dictation');
    updateBadge();
  }
  function updateBadge() {
    var n = mistakeKeys().length, b = $('#mistakeBadge');
    b.hidden = !n; b.textContent = n > 99 ? '99+' : n;
  }

  function maskWord(text, word) {
    var base = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    var stem = base.length > 3 && /e$/.test(base) ? base.slice(0, -1) : base;
    var re = new RegExp('(^|[^A-Za-z])(' + stem + '[a-z]*)', 'ig');
    var found = false;
    var out = esc(text).replace(re, function (m, pre, wd) { found = true; return pre + '<span class="blank" style="min-width:' + Math.max(2.4, wd.length * 0.52) + 'em"></span>'; });
    return { html: out, found: found };
  }

  function renderCard() {
    var w = curWord(), dict = settings.mode === 'dictation';
    var st = stats[w.w.toLowerCase()] || {};
    // top
    var info = (S.pos + 1) + ' / ' + S.list.length;
    $('#posChip').textContent = 'No. ' + info;
    var dots = $('#repeatDots'); dots.innerHTML = '';
    if (+settings.repeat > 1) for (var i = 0; i < +settings.repeat; i++) { var d = el('i'); if (i < W.round) d.className = 'on'; else if (i === W.round) d.className = 'cur'; dots.appendChild(d); }
    var mb = $('#btnMaster'); mb.classList.toggle('on', !!st.m);
    mb.querySelector('span').textContent = st.m ? '已掌握' : '标记掌握';
    mb.style.color = st.m ? 'var(--mint)' : '';
    // word slots
    renderSlots();
    var note = $('#wordNote'); note.innerHTML = '';
    if (w.f) {
      var m = /^(同|亦作)\s*(.+)$/.exec(w.f);
      if (m) { note.innerHTML = esc(m[1]) + ' <span class="alt">' + esc(m[2]) + '</span>'; }
      else note.textContent = w.f;
    }
    // phonetics
    var ph = $('#phonetics'); ph.classList.toggle('off', !settings.showPhonetic);
    var uk = $('#phUK'), us = $('#phUS');
    uk.hidden = !w.uk; us.hidden = !w.us;
    if (w.uk) uk.querySelector('.ph-text').textContent = w.uk;
    if (w.us) us.querySelector('.ph-text').textContent = w.us;
    uk.classList.toggle('primary', settings.accent === 'uk'); us.classList.toggle('primary', settings.accent === 'us');
    // meanings
    var ms = $('#meanings'); ms.innerHTML = '';
    w.m.forEach(function (m) {
      var row = el('div', 'mean');
      if (m[0]) { var p = el('span', 'pos' + (m[0] === 'phr.' ? ' phr' : ''), m[0] === 'phr.' ? '词组' : m[0]); row.appendChild(p); }
      row.appendChild(el('span', 'cn', m[1]));
      ms.appendChild(row);
    });
    applyDictation();
    // extras
    var ex = $('#extras'), sen = $('#sentence'), phr = $('#phrases'), memo = $('#memo');
    sen.innerHTML = ''; phr.innerHTML = ''; memo.textContent = '';
    if (w.s) {
      var mk = maskWord(w.s[0], w.w);
      sen.innerHTML = mk.html + '<span class="cn">' + esc(w.s[1]) + '</span>';
    }
    if (w.p) {
      w.p.slice(0, 3).forEach(function (p) {
        var re = new RegExp(w.w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[a-z]*', 'ig');
        var masked = p[0].replace(re, '～');
        var s = el('span', masked !== p[0] ? 'masked' : '');
        s.innerHTML = '<b>' + esc(masked) + '</b>' + esc(p[1]);
        phr.appendChild(s);
      });
    }
    ex.classList.toggle('off', !settings.showExtras || (!w.s && !w.p));
    $('#btnHint').classList.toggle('used', W.hint);
    // prev/next
    var pv = S.list[S.pos - 1], nx = S.list[S.pos + 1];
    $('#prevWord').textContent = pv != null ? WORDS[pv].w : '';
    $('#btnPrev').style.visibility = pv != null ? 'visible' : 'hidden';
    $('#nextWord').textContent = '跳过';
    void nx;
  }

  function applyDictation() {
    var dict = settings.mode === 'dictation', ms = $('#meanings');
    var revealing = Date.now() < W.revealUntil;
    ms.classList.toggle('hidden-cn', dict && !revealing && !W.showMeaning);
    $('#extras').classList.toggle('dict-hide', dict && !revealing && !W.showMeaning);
    var memo = $('#memo'), w = curWord();
    memo.textContent = (revealing && w.r && settings.showExtras) ? w.r : '';
  }

  function renderSlots() {
    var box = $('#word'), t = W.target, n = t.length;
    var revealing = Date.now() < W.revealUntil || settings.showWord;
    box.className = 'word' + (n > 18 ? ' xlong' : n > 11 ? ' long' : '');
    var html = '';
    for (var i = 0; i < n; i++) {
      var c = t[i], cls = 'slot', shown = '';
      if (c === ' ') cls += ' space';
      else if (!/[A-Za-z]/.test(c)) cls += ' punct';
      if (i < W.typed.length) { cls += ' ok'; shown = c; }
      else if (W.bad && i < W.typed.length + W.bad.length) { cls += ' bad'; shown = W.bad[i - W.typed.length]; }
      else {
        if (i === W.typed.length + W.bad.length) cls += ' cur';
        if (revealing && c !== ' ') { cls += ' hint'; shown = c; }
      }
      html += '<span class="' + cls + '"><span class="ch">' + (shown === ' ' ? '&nbsp;' : esc(shown)) + '</span></span>';
    }
    box.innerHTML = html;
  }

  function renderStats() {
    if (!S) return;
    var act = S.active + (S.lastKey ? Math.min(Date.now() - S.lastKey, 4000) : 0);
    if (paused) act = S.active;
    $('#stTime').textContent = fmtTime(act);
    var mins = act / 60000;
    $('#stWpm').textContent = mins > 0.05 ? Math.round(S.done / mins) : 0;
    var acc = S.keys ? Math.round(S.good / S.keys * 100) : 100;
    $('#stAcc').innerHTML = acc + '<small>%</small>';
    $('#stDone').innerHTML = S.done + '<small>/' + S.list.length + '</small>';
    $('#progressBar').style.width = (S.list.length ? (S.done / S.list.length * 100) : 0) + '%';
  }
  setInterval(function () { if (started && !paused) renderStats(); }, 500);

  /* ================= typing ================= */
  function tick() {
    var now = Date.now();
    if (S.lastKey) S.active += Math.min(now - S.lastKey, 4000);
    S.lastKey = now;
  }

  function typeChar(ch) {
    if (locked || !W) return;
    var t = W.target;
    if (W.typed.length === 0 && !W.bad && ch === ' ') return;
    tick();
    S.keys++;
    if (W.bad && settings.wrongMode === 'block') W.bad = '';
    if (W.bad) {   // keep-mode: blocked until backspace
      if (W.bad.length < 6) W.bad += ch;
      registerError(); renderSlots(); return;
    }
    var exp = t[W.typed.length];
    if (exp != null && ch.toLowerCase() === exp.toLowerCase()) {
      S.good++; W.typed += exp; blip('key'); renderSlots();
      if (W.typed.length === t.length) wordComplete();
    } else {
      registerError();
      if (settings.wrongMode === 'keep') { W.bad = ch; renderSlots(); shake(); }
      else if (settings.wrongMode === 'reset') {
        W.bad = ch; renderSlots(); shake(); locked = true;
        setTimeout(function () { W.bad = ''; W.typed = ''; locked = false; renderSlots(); }, 320);
      } else {
        W.bad = ch; renderSlots(); shake();
        setTimeout(function () { if (W && W.bad) { W.bad = ''; renderSlots(); } }, 300);
      }
    }
  }
  function registerError() { W.errors++; W.roundErrors++; blip('bad'); }
  function shake() {
    var wd = $('#word'); wd.classList.remove('shake'); void wd.offsetWidth; wd.classList.add('shake');
  }
  function backspace() {
    if (locked || !W) return;
    if (W.bad) { W.bad = W.bad.slice(0, -1); }
    else if (W.typed.length) W.typed = W.typed.slice(0, -1);
    renderSlots();
  }

  function recordWord(skipped) {
    var k = W.target.toLowerCase(), s = stats[k] || (stats[k] = { a: 0, e: 0, h: 0, c: 0 });
    s.a++; s.e += W.errors; if (W.hint || skipped) s.h++; if (!W.errors && !W.hint && !skipped) s.c++; s.t = Date.now();
    var bad = W.errors > 0 || W.hint || skipped;
    S.results[S.pos] = { e: W.errors, h: W.hint || skipped, sk: !!skipped };
    if (bad && !s.m) {
      var m = mistakes[k] || (mistakes[k] = { e: 0, h: 0, s: 0 });
      m.t = Date.now(); m.e += W.errors; if (W.hint || skipped) m.h++; m.s = 0;
    } else if (!bad && mistakes[k] && S.type === 'mistakes') {
      mistakes[k].s = (mistakes[k].s || 0) + 1;
      if (mistakes[k].s >= 3) { delete mistakes[k]; toast(W.target + ' 已连续 3 次打对，移出错词本'); }
    }
    save('stats'); save('mistakes'); updateBadge();
  }

  function wordComplete() {
    W.round++;
    blip('done');
    var wd = $('#word'); wd.classList.add('done');
    if (W.round < +settings.repeat) {
      locked = true;
      setTimeout(function () {
        W.typed = ''; W.bad = ''; W.roundErrors = 0; locked = false;
        renderCard();
        if (settings.autoPlay) speak(W.target);
      }, 260);
      return;
    }
    recordWord(false);
    S.done++;
    renderStats();
    advance(settings.mode === 'dictation' ? 700 : 240);
  }

  function advance(delay) {
    locked = true;
    if (settings.mode === 'dictation') { W.showMeaning = true; applyDictation(); }
    setTimeout(function () {
      var card = $('#card'); card.classList.add('leaving');
      setTimeout(function () {
        locked = false;
        if (S.pos + 1 >= S.list.length) { finishSession(); return; }
        S.pos++; loadWord(1);
      }, 160);
    }, delay);
  }

  function skipWord() {
    if (locked || !S) return;
    W.hint = true; recordWord(true); S.done++; renderStats();
    W.revealUntil = Date.now() + 900; renderSlots(); applyDictation();
    advance(650);
  }
  function prevWord() {
    if (locked || !S || S.pos === 0) return;
    S.pos--; if (S.results[S.pos]) { S.done = Math.max(0, S.done - 1); delete S.results[S.pos]; }
    loadWord(1);
  }
  var revealTimer;
  function hint() {
    if (!W || locked) return;
    if (!settings.showWord) W.hint = true;
    W.revealUntil = Date.now() + 1600;
    $('#btnHint').classList.toggle('used', W.hint);
    renderSlots(); applyDictation();
    clearTimeout(revealTimer);
    revealTimer = setTimeout(function () { if (W) { renderSlots(); applyDictation(); } }, 1650);
  }
  function toggleMaster() {
    if (!W) return;
    var k = W.target.toLowerCase(), s = stats[k] || (stats[k] = { a: 0, e: 0, h: 0, c: 0 });
    s.m = !s.m;
    if (s.m) { delete mistakes[k]; toast(W.target + ' 已标记为掌握'); } else toast('已取消掌握标记');
    save('stats'); save('mistakes'); updateBadge();
    renderCard();
    if (s.m && S.type === 'mistakes') { S.results[S.pos] = { e: 0, h: false }; S.done++; advance(200); }
  }

  /* ================= summary ================= */
  function finishSession() {
    var act = S.active, mins = act / 60000;
    var acc = S.keys ? Math.round(S.good / S.keys * 100) : 100;
    var wpm = mins > 0.05 ? Math.round(S.done / mins) : 0;
    var wrongIdx = [];
    S.list.forEach(function (id, i) { var r = S.results[i]; if (r && (r.e || r.h)) wrongIdx.push(i); });
    if (S.type === 'chapter') {
      chapterRecords(S.meta.book)[S.meta.chapter] = { acc: acc, wpm: wpm, time: act, wrong: wrongIdx.length, ts: Date.now() };
      var st = bookState(S.meta.book); st.pos = 0;
      if (S.meta.chapter + 1 < S.meta.total) st.chapter = S.meta.chapter + 1;
      save('records'); save('progress');
    }
    $('#sumKicker').textContent = S.type === 'chapter' ? '本章完成' : '练习完成';
    $('#sumTitle').textContent = S.type === 'chapter' ? (BOOK_MAP[S.meta.book].name + ' · 第 ' + (S.meta.chapter + 1) + ' 章') : S.meta.label;
    $('#sumAcc').textContent = acc + '%';
    $('#sumWpm').textContent = wpm;
    $('#sumTime').textContent = fmtTime(act);
    $('#sumWrong').textContent = wrongIdx.length;
    var box = $('#sumWords'); box.innerHTML = '';
    S.list.forEach(function (id, i) {
      var r = S.results[i] || {}, cls = 'sw' + (r.e ? ' bad' : r.h ? ' hint' : '');
      var sp = el('span', cls, WORDS[id].w);
      if (r.e) sp.appendChild(el('small', '', '×' + r.e)); else if (r.h) sp.appendChild(el('small', '', r.sk ? '跳过' : '提示'));
      sp.title = meanText(WORDS[id], 60);
      box.appendChild(sp);
    });
    S.lastWrong = wrongIdx.map(function (i) { return keyOf(S.list[i]); });
    $('#sumMistakes').hidden = !wrongIdx.length;
    var hasNext = S.type === 'chapter' && S.meta.chapter + 1 < S.meta.total;
    $('#sumNext').querySelector('span').textContent = S.type === 'chapter' ? (hasNext ? '下一章' : '回到第一章') : '返回章节';
    $('#summaryOverlay').hidden = false;
    paused = true;
  }
  function closeSummary() { $('#summaryOverlay').hidden = true; paused = false; }
  function sumNext() {
    closeSummary();
    if (S.type === 'chapter') { var nx = S.meta.chapter + 1 < S.meta.total ? S.meta.chapter + 1 : 0; startChapter(S.meta.book, nx, 0); }
    else exitMistakes();
  }
  function sumRetry() {
    closeSummary();
    if (S.type === 'chapter') startChapter(S.meta.book, S.meta.chapter, 0);
    else { var ids = S.list.slice(); var meta = S.meta; newSession('mistakes', shuffled(ids, Date.now() & 0xffff), meta); renderHeader(); loadWord(); }
  }
  function sumMistakes() { var keys = S.lastWrong || []; closeSummary(); startMistakes(keys, S.type === 'chapter' ? '本章错词' : S.meta.label); }

  /* ================= panels ================= */
  var openPanel = null;
  function showPanel(id) {
    closePanels();
    var m = $(id); m.hidden = false; openPanel = m;
    paused = true;
  }
  function closePanels() {
    $$('.sheet-mask,.pop-mask').forEach(function (m) { m.hidden = true; });
    if (openPanel) { openPanel = null; paused = false; if (S) S.lastKey = 0; }
  }
  $$('[data-close]').forEach(function (b) { b.onclick = closePanels; });
  $$('.sheet-mask,.pop-mask').forEach(function (m) { m.addEventListener('mousedown', function (e) { if (e.target === m) closePanels(); }); });

  /* ---- book panel ---- */
  var panelBook = null, panelChapter = 0;
  function openBooks() {
    panelBook = S && S.type === 'chapter' ? S.meta.book : progress.book;
    panelChapter = bookState(panelBook).chapter;
    renderBookPanel();
    showPanel('#bookMask');
    var cur = $('.ch-chip.sel'); if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  function renderBookPanel() {
    var list = $('#bookList'); list.innerHTML = '';
    var lastGroup = '';
    BOOKS.forEach(function (b) {
      if (b.group !== lastGroup) { list.appendChild(el('div', 'bl-group', b.group)); lastGroup = b.group; }
      var it = el('button', 'bl-item' + (b.id === panelBook ? ' on' : ''));
      var learned = learnedCount(b.ids);
      it.innerHTML = '<span class="bl-name">' + esc(b.name) + '</span><span class="bl-meta"><span>' + b.ids.length + ' 词</span><span>已练 ' + learned + '</span></span><span class="bl-bar"><i style="width:' + (learned / b.ids.length * 100).toFixed(1) + '%"></i></span>';
      it.onclick = function () { panelBook = b.id; panelChapter = bookState(b.id).chapter; renderBookPanel(); };
      list.appendChild(it);
    });
    var b = BOOK_MAP[panelBook], st = bookState(panelBook), chs = chaptersOf(panelBook);
    if (panelChapter >= chs.length) panelChapter = chs.length - 1;
    $('#cpTitle').textContent = b.name;
    var recs = chapterRecords(panelBook), doneN = Object.keys(recs).length;
    $('#cpSub').textContent = (b.desc ? b.desc + ' · ' : '') + b.ids.length + ' 词 · 共 ' + chs.length + ' 章 · 已完成 ' + doneN + ' 章';
    $$('#orderSeg button').forEach(function (x) { x.classList.toggle('on', x.dataset.order === st.order); });
    $$('#sizeSeg button').forEach(function (x) { x.classList.toggle('on', +x.dataset.size === +settings.chapterSize); });
    $('#btnReshuffle').hidden = st.order !== 'random';
    var grid = $('#chapterGrid'); grid.innerHTML = '';
    var curBook = S && S.type === 'chapter' && S.meta.book === panelBook;
    chs.forEach(function (ids, i) {
      var r = recs[i];
      var c = el('button', 'ch-chip' + (r ? ' done' : '') + (curBook && S.meta.chapter === i ? ' cur' : '') + (i === panelChapter ? ' sel' : ''), String(i + 1));
      c.title = WORDS[ids[0]].w + ' – ' + WORDS[ids[ids.length - 1]].w + (r ? '（正确率 ' + r.acc + '%）' : '');
      if (r) { var dot = el('i', 'acc'); dot.style.background = r.acc >= 95 ? 'var(--mint)' : r.acc >= 85 ? 'var(--honey)' : 'var(--rose)'; if (i !== panelChapter) c.appendChild(dot); }
      c.onclick = function () { panelChapter = i; renderBookPanel(); };
      c.ondblclick = function () { closePanels(); startChapter(panelBook, i, 0); };
      grid.appendChild(c);
    });
    var pv = $('#chapterPreview'); pv.innerHTML = '';
    var ids = chs[panelChapter] || [];
    var head = el('div', 'pv-head');
    var r = recs[panelChapter];
    head.innerHTML = '<div class="pv-title"><b>第 ' + (panelChapter + 1) + ' 章</b> · ' + ids.length + ' 词' + (r ? ' · 上次正确率 ' + r.acc + '%，' + r.wpm + ' 词/分' : '') + '</div>';
    var go = el('button', 'primary-btn small'); go.innerHTML = '<svg class="ic"><use href="#i-play"/></svg>开始本章';
    var resume = curBook && S.meta.chapter === panelChapter && S.pos > 0;
    if (!resume && !curBook && st.chapter === panelChapter && st.pos > 0) resume = true;
    go.onclick = function () { closePanels(); startChapter(panelBook, panelChapter, 0); };
    var btns = el('div', 'row-btns');
    if (resume) { var rb = el('button', 'link-btn', '从第 ' + ((curBook ? S.pos : st.pos) + 1) + ' 个继续'); rb.onclick = function () { closePanels(); if (!curBook) startChapter(panelBook, panelChapter, st.pos); }; btns.appendChild(rb); }
    btns.appendChild(go);
    head.appendChild(btns);
    pv.appendChild(head);
    var lst = el('div', 'pv-list');
    ids.forEach(function (id) {
      var w = WORDS[id], s = stats[w.w.toLowerCase()];
      var it = el('div', 'pv-item' + (s && s.m ? ' m' : '') + (mistakes[w.w.toLowerCase()] ? ' e' : ''));
      it.innerHTML = '<span class="w">' + esc(w.w) + '</span><span class="c">' + esc(meanText(w, 40)) + '</span>';
      it.title = w.w + '  ' + meanText(w);
      lst.appendChild(it);
    });
    pv.appendChild(lst);
  }
  $('#orderSeg').onclick = function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var st = bookState(panelBook); if (st.order === b.dataset.order) return;
    st.order = b.dataset.order; st.chapter = 0; st.pos = 0; panelChapter = 0; save('progress'); renderBookPanel();
  };
  $('#sizeSeg').onclick = function (e) {
    var b = e.target.closest('button'); if (!b) return; setChapterSize(+b.dataset.size); renderBookPanel();
  };
  $('#btnReshuffle').onclick = function () {
    var st = bookState(panelBook); st.seed = 1 + Math.floor(Math.random() * 1e9); st.chapter = 0; st.pos = 0; panelChapter = 0; save('progress'); renderBookPanel(); toast('已重新打乱');
  };
  function setChapterSize(n) {
    if (+settings.chapterSize === n) return;
    var old = +settings.chapterSize;
    Object.keys(progress.books).forEach(function (id) {
      var st = progress.books[id]; var first = st.chapter * old + (st.pos || 0);
      st.chapter = Math.floor(first / n); st.pos = first % n;
    });
    if (panelBook) panelChapter = Math.floor(panelChapter * old / n);
    settings.chapterSize = n; save('settings'); save('progress');
    if (S && S.type === 'chapter') { var st = bookState(S.meta.book); startChapter(S.meta.book, st.chapter, st.pos); }
    syncSettingsUI();
  }

  /* ---- mistakes panel ---- */
  var mistakeSort = 'recent';
  function openMistakes() { renderMistakes(); showPanel('#mistakeMask'); }
  function renderMistakes() {
    var keys = mistakeKeys();
    $('#mistakeCount').textContent = keys.length ? keys.length + ' 词' : '';
    $$('#mistakeSort button').forEach(function (b) { b.classList.toggle('on', b.dataset.sort === mistakeSort); });
    keys.sort(function (a, b) {
      if (mistakeSort === 'errors') return (mistakes[b].e + mistakes[b].h) - (mistakes[a].e + mistakes[a].h);
      if (mistakeSort === 'alpha') return a < b ? -1 : 1;
      return (mistakes[b].t || 0) - (mistakes[a].t || 0);
    });
    var list = $('#mistakeList'); list.innerHTML = '';
    $('#btnPracticeMistakes').disabled = !keys.length;
    $('#btnPracticeMistakes').style.opacity = keys.length ? '' : '.5';
    if (!keys.length) {
      list.innerHTML = '<div class="empty"><svg><use href="#i-mistake"/></svg>还没有错词<br>打错或看过提示的单词会出现在这里</div>';
      return;
    }
    var frag = document.createDocumentFragment();
    keys.forEach(function (k) {
      var w = WORDS[KEY_INDEX[k]], m = mistakes[k];
      var row = el('div', 'mk');
      row.innerHTML = '<div class="mk-main"><div class="mk-word"><button class="sp" title="朗读"><svg><use href="#i-speaker"/></svg></button>' + esc(w.w) + '</div><div class="mk-cn">' + esc(meanText(w, 60)) + '</div></div>' +
        '<div class="mk-meta">' + (m.e ? '错 ' + m.e + ' 次' : '') + (m.h ? '<span>提示 ' + m.h + ' 次</span>' : '') + (m.s ? '<span>连对 ' + m.s + '/3</span>' : '') + '</div>';
      var mb = el('button', 'mini-btn'); mb.innerHTML = '<svg class="ic"><use href="#i-check"/></svg><span>已掌握</span>'; mb.title = '标记为已掌握并移出';
      mb.onclick = function () { var s = stats[k] || (stats[k] = { a: 0, e: 0, h: 0, c: 0 }); s.m = true; delete mistakes[k]; save('stats'); save('mistakes'); updateBadge(); row.style.opacity = '0'; setTimeout(renderMistakes, 180); };
      row.appendChild(mb);
      row.querySelector('.sp').onclick = function () { speak(w.w); };
      frag.appendChild(row);
    });
    list.appendChild(frag);
  }
  $('#mistakeSort').onclick = function (e) { var b = e.target.closest('button'); if (!b) return; mistakeSort = b.dataset.sort; renderMistakes(); };
  $('#btnPracticeMistakes').onclick = function () { var keys = mistakeKeys(); closePanels(); startMistakes(keys, '错词练习'); };
  $('#btnClearMistakes').onclick = function () { if (!mistakeKeys().length) return; if (confirm('确定清空错词本吗？此操作不可撤销。')) { mistakes = {}; save('mistakes'); updateBadge(); renderMistakes(); } };

  /* ---- settings panel ---- */
  function syncSettingsUI() {
    $$('#settingsBody [data-set]').forEach(function (c) {
      var k = c.dataset.set, v = settings[k];
      if (c.classList.contains('switch')) c.classList.toggle('on', !!v);
      else if (c.classList.contains('seg')) $$('button', c).forEach(function (b) { b.classList.toggle('on', String(b.dataset.v) === String(v)); });
      else if (c.type === 'range') c.value = v;
    });
    $('#volVal').textContent = settings.volume;
    var practiced = Object.keys(stats).filter(function (k) { return stats[k].a; }).length;
    var mastered = Object.keys(stats).filter(function (k) { return stats[k].m; }).length;
    $('#dataNote').textContent = '已练习 ' + practiced + ' 词，已掌握 ' + mastered + ' 词，错词 ' + mistakeKeys().length + ' 词。记录仅保存在本机浏览器中，可导出备份。';
  }
  function applySetting(k, v) {
    if (k === 'chapterSize') { setChapterSize(+v); return; }
    settings[k] = (k === 'repeat' || k === 'volume') ? +v : v;
    save('settings'); syncSettingsUI();
    if (k === 'accent') { audioFails = 0; if (W) speak(W.target); }
    if (S && W) { if (k === 'repeat') W.round = Math.min(W.round, +v - 1); renderHeader(); renderCard(); }
  }
  $('#settingsBody').addEventListener('click', function (e) {
    var sw = e.target.closest('.switch');
    if (sw) { applySetting(sw.dataset.set, !settings[sw.dataset.set]); return; }
    var b = e.target.closest('.seg button');
    if (b) { var seg = b.closest('[data-set]'); if (seg) applySetting(seg.dataset.set, b.dataset.v); }
  });
  $('#settingsBody input[type=range]').addEventListener('input', function (e) { settings.volume = +e.target.value; $('#volVal').textContent = settings.volume; save('settings'); });
  $('#settingsBody input[type=range]').addEventListener('change', function () { if (W) speak(W.target); });
  $('#btnExport').onclick = function () {
    var blob = new Blob([JSON.stringify({ app: 'ciyun', v: 1, at: new Date().toISOString(), settings: settings, stats: stats, mistakes: mistakes, progress: progress, records: records })], { type: 'application/json' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    var d = new Date(); a.download = '词韵学习记录-' + d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2) + '.json';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  };
  $('#btnImport').onclick = function () { $('#importFile').click(); };
  $('#importFile').onchange = function (e) {
    var f = e.target.files[0]; if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var j = JSON.parse(rd.result); if (j.app !== 'ciyun') throw new Error('bad');
        settings = Object.assign({}, DEFAULTS, j.settings || {}); stats = j.stats || {}; mistakes = j.mistakes || {}; progress = j.progress || { book: 'all', books: {} }; records = j.records || {};
        save(); toast('导入成功'); closePanels(); boot();
      } catch (err) { toast('文件格式不正确'); }
    };
    rd.readAsText(f); e.target.value = '';
  };
  $('#btnReset').onclick = function () {
    if (!confirm('将清除所有练习记录、错词本与设置，确定吗？')) return;
    settings = Object.assign({}, DEFAULTS); stats = {}; mistakes = {}; progress = { book: 'all', books: {} }; records = {};
    save(); closePanels(); boot(); toast('已重置');
  };

  /* ================= wiring ================= */
  $('#bookPill').onclick = openBooks;
  $('#btnMistakes').onclick = openMistakes;
  $('#btnSettings').onclick = function () { syncSettingsUI(); showPanel('#settingsMask'); };
  $('#btnHelp').onclick = function () { showPanel('#helpMask'); };
  $('#btnMode').onclick = toggleMode;
  $('#btnSpeak').onclick = function () { if (W) speak(W.target); focusInput(); };
  $('#btnHint').onclick = function () { hint(); focusInput(); };
  $('#btnNext').onclick = function () { skipWord(); focusInput(); };
  $('#btnPrev').onclick = function () { prevWord(); focusInput(); };
  $('#btnMaster').onclick = function () { toggleMaster(); focusInput(); };
  $('#btnPause').onclick = function () { togglePause(); };
  $('#sumNext').onclick = sumNext; $('#sumRetry').onclick = sumRetry; $('#sumMistakes').onclick = sumMistakes;
  $('#btnStart').onclick = function () { begin(); };
  $('#card').addEventListener('click', function (e) { if (!e.target.closest('button')) focusInput(); });

  function toggleMode() {
    settings.mode = settings.mode === 'dictation' ? 'normal' : 'dictation'; save('settings');
    renderHeader(); if (W) renderCard();
    toast(settings.mode === 'dictation' ? '默写模式：只听发音与音标' : '释义模式');
  }

  var isTouch = window.matchMedia && matchMedia('(pointer:coarse)').matches;
  function focusInput() { var g = $('#ghostInput'); if (isTouch || document.activeElement === g) { g.value = '~'; g.focus({ preventScroll: true }); } }

  function begin() {
    var ov = $('#startOverlay');
    if (!started) {
      started = true;
      // unlock audio inside the user gesture
      if (W) speak(W.target);
      try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) {}
    } else if (W && settings.autoPlay) speak(W.target);
    paused = false; document.body.classList.remove('paused');
    if (S) S.lastKey = 0;
    ov.classList.add('hide'); setTimeout(function () { ov.hidden = true; ov.classList.remove('hide'); }, 300);
    focusInput();
  }
  function togglePause() {
    if (!started) return;
    var ov = $('#startOverlay');
    if (!paused) {
      if (S && S.lastKey) { S.active += Math.min(Date.now() - S.lastKey, 4000); S.lastKey = 0; }
      paused = true; document.body.classList.add('paused');
      $('#startLabel').textContent = '继续练习';
      $('.start-card h1').textContent = '已暂停';
      $('.start-card .lead').innerHTML = '休息一下。<br>按 Esc 或任意键继续。';
      renderStartMeta();
      ov.hidden = false; renderStats();
    } else begin();
  }
  function renderStartMeta() {
    var all = BOOK_MAP.all;
    var practiced = Object.keys(stats).filter(function (k) { return stats[k].a; }).length;
    $('#startMeta').innerHTML = '<span><b>' + all.ids.length + '</b>词</span><span>已练 <b>' + practiced + '</b></span><span>错词 <b>' + mistakeKeys().length + '</b></span>';
  }

  document.addEventListener('keydown', function (e) {
    var k = e.key;
    var mod = e.ctrlKey || e.metaKey;
    // summary
    if (!$('#summaryOverlay').hidden) {
      if (k === 'Enter') { e.preventDefault(); sumNext(); }
      else if ((k === 'r' || k === 'R') && !mod) { e.preventDefault(); sumRetry(); }
      else if ((k === 'm' || k === 'M') && !mod && !$('#sumMistakes').hidden) { e.preventDefault(); sumMistakes(); }
      return;
    }
    if (openPanel) { if (k === 'Escape') { e.preventDefault(); closePanels(); } return; }
    if (e.target && e.target.tagName === 'INPUT' && e.target.id !== 'ghostInput') return;
    if (!$('#startOverlay').hidden) {
      if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta' || mod) return;
      e.preventDefault(); begin(); return;
    }
    if (k === 'Process' || e.isComposing || e.keyCode === 229) { if (!isTouch) toast('检测到中文输入法，请切换为英文输入'); return; }
    if (mod && (k === 'j' || k === 'J')) { e.preventDefault(); if (W) speak(W.target); return; }
    if (mod && k === 'ArrowRight') { e.preventDefault(); skipWord(); return; }
    if (mod && k === 'ArrowLeft') { e.preventDefault(); prevWord(); return; }
    if (e.ctrlKey && (k === 'd' || k === 'D')) { e.preventDefault(); toggleMode(); return; }
    if (e.ctrlKey && (k === 'm' || k === 'M')) { e.preventDefault(); toggleMaster(); return; }
    if (mod || e.altKey) return;
    if (k === 'Escape') { e.preventDefault(); togglePause(); return; }
    if (paused) return;
    if (k === 'Tab') { e.preventDefault(); hint(); return; }
    if (k === 'Backspace') { e.preventDefault(); backspace(); return; }
    if (k === '?') { e.preventDefault(); showPanel('#helpMask'); return; }
    if (k.length === 1) { e.preventDefault(); typeChar(k); }
  });

  // mobile / virtual keyboards
  var gi = $('#ghostInput');
  gi.addEventListener('input', function (e) {
    if (!started) { begin(); }
    if (e.inputType === 'deleteContentBackward') backspace();
    else { var v = gi.value.replace(/^~/, ''); for (var i = 0; i < v.length; i++) typeChar(v[i]); }
    gi.value = '~';
  });
  window.addEventListener('blur', function () { if (S && S.lastKey) { S.active += Math.min(Date.now() - S.lastKey, 4000); S.lastKey = 0; } });

  /* ================= boot ================= */
  function boot() {
    if (!BOOK_MAP[progress.book]) progress.book = 'all';
    var st = bookState(progress.book);
    var chs = chaptersOf(progress.book);
    if (st.chapter >= chs.length) { st.chapter = 0; st.pos = 0; }
    startChapter(progress.book, st.chapter, st.pos || 0);
    renderStartMeta();
    syncSettingsUI();
  }
  boot();
})();
