/* appearance.js — palette (Plaster · Paper · Ink) and light/dark for every Nick Lian product page.
   Contract with design-tokens.css (v3.1):
     <html>                                  Plaster, follows the OS light/dark setting
     <html data-theme="paper|ink">           another palette
     <html data-scheme="light|dark">         forced light or dark
   Defaults write no attribute: an attribute present means the person chose something.
   The choice is stored in localStorage (nl-theme, nl-scheme). The inline boot snippet at the top of <head> applies it
   before the first paint, so there is no flash; this file keeps everything in sync afterwards.

   Two controls, one writer (Appearance.set):
     Appearance.bindToggle(button)            the top-bar ◐: light/dark only, never the palette. Its name stays
                                              "Dark mode"; aria-pressed says whether dark is on.
     Appearance.bindSettings(button, opts)    the top-bar gear: opens the Settings dialog. `opts` (or a function
                                              returning it, read on every open) may carry `strings` (see STRINGS)
                                              and `sections` (extra nodes after Appearance, e.g. a connection form).
     Appearance.settings(opts)                the Theme and Appearance controls alone, for mounting elsewhere.
     Single-key shortcuts (products that have them pass `shortcuts`, a one-line description of their keys): an On | Off
     group after Appearance, stored as nl-shortcuts ("off" turns them off; anything else, or nothing, is on). Products
     read Appearance.shortcutsOn() before acting on a page-level single key (WCAG 2.1.4; ruling 2026-09-16 20:11 Q3).
   No dependencies. Styles use design tokens only. */
(function (root) {
  'use strict';
  var KEY_THEME = 'nl-theme', KEY_SCHEME = 'nl-scheme', KEY_SHORTCUTS = 'nl-shortcuts';
  var THEMES = ['plaster', 'paper', 'ink'];
  var THEME_NAMES = { plaster: 'Plaster', paper: 'Paper', ink: 'Ink' };   // names, not translated
  var SCHEMES = ['system', 'light', 'dark'];
  var STRINGS = {
    en: { title: 'Settings', theme: 'Theme', appearance: 'Appearance', system: 'System', light: 'Light', dark: 'Dark',
          shortcuts: 'Single-key shortcuts', on: 'On', off: 'Off',
          caption: 'Saved in this browser only. Plaster and System are the defaults.', done: 'Done' },
    zh: { title: '设置', theme: '配色', appearance: '明暗', system: '跟随系统', light: '浅色', dark: '深色',
          shortcuts: '单键快捷键', on: '开', off: '关',
          caption: '只保存在这个浏览器里。Plaster 与「跟随系统」是默认值。', done: '完成' }
  };
  var doc = document, html = doc.documentElement;
  var toggles = [], uid = 0;

  function get() {
    var t = html.getAttribute('data-theme'), s = html.getAttribute('data-scheme');
    return { theme: t === 'paper' || t === 'ink' ? t : 'plaster', scheme: s === 'light' || s === 'dark' ? s : 'system' };
  }
  function isDark() {
    var s = get().scheme;
    return s === 'dark' || (s === 'system' && !!root.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  }
  function syncMeta() {
    var bg = getComputedStyle(html).getPropertyValue('--bg').trim();
    if (!bg) return;
    var metas = doc.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', bg);
  }
  function shortcutsOn() { try { return localStorage.getItem(KEY_SHORTCUTS) !== 'off'; } catch (e) { return true; } }
  function setShortcuts(on) {
    try { localStorage.setItem(KEY_SHORTCUTS, on ? 'on' : 'off'); } catch (e) { /* private mode: nothing to keep */ }
    syncControls();
    try { doc.dispatchEvent(new CustomEvent('shortcutschange', { detail: { on: shortcutsOn() } })); } catch (e) {}
    return shortcutsOn();
  }
  function syncControls() {
    var cur = get(), dark = String(isDark()), i, sc = shortcutsOn() ? 'on' : 'off';
    for (i = 0; i < toggles.length; i++) toggles[i].setAttribute('aria-pressed', dark);
    var radios = doc.querySelectorAll('.nl-settings input[type="radio"]');
    for (i = 0; i < radios.length; i++) {
      var r = radios[i], kind = r.getAttribute('data-nl');
      r.checked = kind === 'theme' ? r.value === cur.theme : kind === 'shortcuts' ? r.value === sc : r.value === cur.scheme;
    }
    // swatches preview each palette in the light/dark that is currently forced (system: the OS decides)
    var sw = doc.querySelectorAll('.nl-swatch');
    for (i = 0; i < sw.length; i++) {
      if (cur.scheme === 'system') sw[i].removeAttribute('data-scheme'); else sw[i].setAttribute('data-scheme', cur.scheme);
    }
  }
  function set(next) {
    var cur = get();
    var t = next && next.theme ? next.theme : cur.theme, s = next && next.scheme ? next.scheme : cur.scheme;
    if (t === 'plaster') html.removeAttribute('data-theme'); else html.setAttribute('data-theme', t);
    if (s === 'system') html.removeAttribute('data-scheme'); else html.setAttribute('data-scheme', s);
    try { localStorage.setItem(KEY_THEME, t); localStorage.setItem(KEY_SCHEME, s); } catch (e) { /* private mode: still applies for this page */ }
    syncMeta();
    syncControls();
    try { doc.dispatchEvent(new CustomEvent('appearancechange', { detail: get() })); } catch (e) {}
    return get();
  }
  // From "follow the system" a press picks an explicit Light or Dark; going back to System is done in Settings.
  function toggleScheme() { return set({ scheme: isDark() ? 'light' : 'dark' }); }
  function bindToggle(btn) {
    if (!btn || toggles.indexOf(btn) !== -1) return btn;
    toggles.push(btn);
    btn.removeAttribute('aria-haspopup');
    btn.addEventListener('click', function () { toggleScheme(); });
    btn.setAttribute('aria-pressed', String(isDark()));
    return btn;
  }

  var styled = false;
  function injectStyle() {
    if (styled) return; styled = true;
    var css = [
      '.nl-settings{display:grid;gap:var(--space-5);min-width:0}',
      '.nl-pickset{border:0;margin:0;padding:0;display:grid;gap:var(--space-3);min-width:0}',
      '.nl-pickset legend{padding:0;margin-bottom:var(--space-3);font:var(--weight-semibold) var(--text-2xs)/1 var(--font-sans);letter-spacing:var(--tracking-caps);text-transform:uppercase;color:var(--text-3)}',
      '.nl-picks{display:flex;flex-wrap:wrap;gap:var(--space-3);justify-self:start}',
      '.nl-pick{position:relative;display:inline-flex;align-items:center;gap:var(--space-3);cursor:pointer;padding:var(--space-2) var(--space-3) var(--space-2) var(--space-2);',
      'border:1px solid var(--border);border-radius:var(--radius-md);background:var(--paper);color:var(--text);font-size:var(--text-sm);',
      'transition:border-color var(--dur-fast) var(--ease-out),background-color var(--dur-fast) var(--ease-out),transform var(--dur-fast) var(--ease-out)}',
      '.nl-pick:active{transform:scale(var(--press-scale))}',
      '.nl-pick input,.nl-seg input{position:absolute;opacity:0;width:1px;height:1px;margin:0}',
      '.nl-pick:has(input:checked){border-color:var(--accent-text);background:var(--accent-tint);color:var(--accent-tint-text)}',
      '.nl-pick:has(input:focus-visible),.nl-seg label:has(input:focus-visible){outline:var(--border-focus-width) solid var(--focus);outline-offset:2px}',
      '.nl-swatch{display:grid;grid-template-columns:repeat(3,1fr);width:46px;height:26px;border-radius:var(--radius-xs);overflow:hidden;border:1px solid var(--border);flex:none}',
      '.nl-swatch i{display:block}',
      '.nl-swatch i:nth-child(1){background:var(--bg)}.nl-swatch i:nth-child(2){background:var(--band)}.nl-swatch i:nth-child(3){background:var(--point)}',
      '.nl-seg{display:inline-flex;width:fit-content;max-width:100%;justify-self:start;padding:2px;gap:2px;border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface-2)}',
      '.nl-seg label{position:relative;display:inline-flex;align-items:center;justify-content:center;min-width:72px;height:28px;padding:0 var(--space-2);border-radius:var(--radius-sm);',
      'cursor:pointer;font-size:var(--text-xs);color:var(--text-2);transition:background-color var(--dur-fast) var(--ease-out),color var(--dur-fast) var(--ease-out)}',
      // the selected segment needs a ring: paper on the sunken track alone is 1.03-1.25:1; the ring is 3.29-4.19:1
      '.nl-seg label:has(input:checked){background:var(--paper);color:var(--text);font-weight:var(--weight-medium);box-shadow:var(--shadow-1),inset 0 0 0 1px var(--border-input)}',
      '.nl-caption{margin:0;font-family:var(--font-display);font-style:var(--caption-style);font-weight:400;font-variation-settings:"opsz" var(--opsz-caption);',
      'font-size:var(--text-sm);line-height:var(--leading-relaxed);color:var(--text-2);max-width:var(--measure)}',
      '.nl-note{margin:0;font-size:var(--text-xs);line-height:var(--leading-normal);color:var(--text-2);max-width:var(--measure)}',
      '@media (pointer:coarse){.nl-seg label{height:var(--touch-min)}.nl-pick{min-height:var(--touch-min)}.nl-dialog .nl-done{min-height:var(--touch-min);min-width:var(--touch-min)}}',
      '@media (prefers-reduced-motion:reduce){.nl-pick:active,.nl-dialog .nl-done:active{transform:none;background:var(--neutral-tint)}}',
      '.nl-dialog{border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--surface-raised);color:var(--text);box-shadow:var(--shadow-2);',
      'padding:var(--space-5);width:min(460px,calc(100vw - 2 * var(--gutter,16px)));max-width:100%;max-height:calc(100dvh - 2 * var(--gutter,16px));overflow:auto;overscroll-behavior:contain}',
      '.nl-dialog::backdrop{background:var(--overlay)}',
      '.nl-dialog h2{margin:0 0 var(--space-5);font:var(--display-weight,600) var(--text-lg)/var(--leading-tight) var(--font-display);font-variation-settings:"opsz" var(--opsz-title)}',
      '.nl-dialog .nl-section{margin-top:var(--space-6);padding-top:var(--space-5);border-top:1px solid var(--hairline)}',
      '.nl-dialog .nl-acts{display:flex;justify-content:flex-end;margin-top:var(--space-6)}',
      // Done commits nothing, so it is the neutral button, not the filled primary
      '.nl-dialog .nl-done{min-height:var(--control-h);padding:0 var(--space-4);border-radius:var(--radius-sm);border:1px solid var(--border-input);background:var(--paper);color:var(--text);',
      'font:inherit;font-size:var(--text-sm);font-weight:var(--weight-medium);cursor:pointer;transition:background-color var(--dur-fast) var(--ease-out),transform var(--dur-fast) var(--ease-out)}',
      '.nl-dialog .nl-done:active{transform:scale(var(--press-scale))}',
      '.nl-dialog .nl-done:focus-visible{outline:var(--border-focus-width) solid var(--focus);outline-offset:2px}',
      '@media (hover:hover) and (pointer:fine){.nl-pick:hover{border-color:var(--border-strong)}.nl-seg label:hover{color:var(--text)}.nl-dialog .nl-done:hover{background:var(--surface-hover)}}'
    ].join('');
    var st = doc.createElement('style'); st.setAttribute('data-nl-appearance', ''); st.textContent = css; doc.head.appendChild(st);
  }

  function el(tag, attrs, kids) {
    var n = doc.createElement(tag), k;
    for (k in attrs || {}) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c); });
    return n;
  }
  function radio(kind, name, value, checked) {
    var input = el('input', { type: 'radio', name: name, value: value, 'data-nl': kind });
    input.checked = checked;
    input.addEventListener('change', function () { if (!input.checked) return; if (kind === 'shortcuts') { setShortcuts(value === 'on'); return; } var n = {}; n[kind] = value; set(n); });
    return input;
  }
  function strings(opts) {
    var s = {}, base = STRINGS.en, over = (opts && opts.strings) || {}, k;
    for (k in base) s[k] = over[k] || base[k];
    return s;
  }

  /* The Theme and Appearance controls. Each group is named once, by its fieldset legend. Options: { strings, caption:false } */
  function settings(opts) {
    injectStyle();
    opts = opts || {};
    var S = strings(opts), cur = get(), n = ++uid;
    var picks = el('div', { class: 'nl-picks' });
    THEMES.forEach(function (t) {
      var sw = el('span', { class: 'nl-swatch', 'data-theme': t, 'aria-hidden': 'true' }, [el('i'), el('i'), el('i')]);
      if (cur.scheme !== 'system') sw.setAttribute('data-scheme', cur.scheme);
      picks.appendChild(el('label', { class: 'nl-pick' }, [radio('theme', 'nl-theme-' + n, t, t === cur.theme), sw, THEME_NAMES[t]]));
    });
    var seg = el('div', { class: 'nl-seg' });
    SCHEMES.forEach(function (s) { seg.appendChild(el('label', {}, [radio('scheme', 'nl-scheme-' + n, s, s === cur.scheme), S[s]])); });
    var box = el('div', { class: 'nl-settings' }, [
      el('fieldset', { class: 'nl-pickset' }, [el('legend', {}, [S.theme]), picks]),
      el('fieldset', { class: 'nl-pickset' }, [el('legend', {}, [S.appearance]), seg])
    ]);
    if (opts.shortcuts) {
      var on = shortcutsOn(), keys = el('div', { class: 'nl-seg' }), note = el('p', { class: 'nl-note', id: 'nl-shortcuts-note-' + n }, [String(opts.shortcuts)]);
      ['on', 'off'].forEach(function (v) { keys.appendChild(el('label', {}, [radio('shortcuts', 'nl-shortcuts-' + n, v, (v === 'on') === on), S[v]])); });
      box.appendChild(el('fieldset', { class: 'nl-pickset', 'aria-describedby': 'nl-shortcuts-note-' + n }, [el('legend', {}, [S.shortcuts]), keys, note]));
    }
    if (opts.caption !== false) box.appendChild(el('p', { class: 'nl-caption' }, [S.caption]));
    return box;
  }

  function openSettings(opener, opts) {
    injectStyle();
    opts = opts || {};
    var S = strings(opts);
    var old = doc.getElementById('nl-settings-dialog'); if (old) old.remove();
    var dlg = el('dialog', { id: 'nl-settings-dialog', class: 'nl-dialog', 'aria-labelledby': 'nl-settings-h' });
    var done = el('button', { type: 'button', class: 'nl-done' }, [S.done]);
    done.addEventListener('click', function () { dlg.close(); });
    dlg.appendChild(el('h2', { id: 'nl-settings-h' }, [S.title]));
    dlg.appendChild(settings(opts));
    (opts.sections || []).forEach(function (sec) {
      var node = typeof sec === 'function' ? sec(dlg) : sec;
      if (node) dlg.appendChild(el('div', { class: 'nl-section' }, [node]));
    });
    dlg.appendChild(el('div', { class: 'nl-acts' }, [done]));
    dlg.addEventListener('close', function () {
      dlg.remove();
      if (typeof opts.onClose === 'function') opts.onClose();
      if (opener && opener.focus) opener.focus();
    });
    // Escape closes even where the native close watcher does not fire (non-modal fallback, synthetic key events).
    dlg.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dlg.close(); } });
    // A pointer click on the backdrop closes. Judged by coordinates: the dialog's own padding is also the dialog
    // element, and keyboard-made clicks (detail 0, coordinates 0,0) must never count.
    dlg.addEventListener('click', function (e) {
      if (e.target !== dlg || !e.detail) return;
      var r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
    });
    doc.body.appendChild(dlg);
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    var first = (opts.focus && dlg.querySelector(opts.focus)) || dlg.querySelector('input[data-nl="theme"]:checked');
    if (first) first.focus();
    return dlg;
  }
  function bindSettings(btn, opts) {
    if (!btn || btn.getAttribute('data-nl-settings') === 'bound') return btn;
    btn.setAttribute('data-nl-settings', 'bound');
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.addEventListener('click', function () { openSettings(btn, typeof opts === 'function' ? opts() : opts); });
    return btn;
  }

  // Keep theme-color metas and the toggle right when the OS flips light/dark while the page follows it.
  if (root.matchMedia) {
    var mq = matchMedia('(prefers-color-scheme: dark)');
    var onFlip = function () { if (get().scheme === 'system') { syncMeta(); syncControls(); } };
    if (mq.addEventListener) mq.addEventListener('change', onFlip); else if (mq.addListener) mq.addListener(onFlip);
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', syncMeta); else syncMeta();

  root.Appearance = {
    get: get, set: set, isDark: isDark, toggleScheme: toggleScheme, bindToggle: bindToggle, bindSettings: bindSettings,
    settings: settings, openSettings: openSettings, STRINGS: STRINGS, shortcutsOn: shortcutsOn, setShortcuts: setShortcuts,
    THEMES: THEMES, SCHEMES: SCHEMES, KEYS: { theme: KEY_THEME, scheme: KEY_SCHEME, shortcuts: KEY_SHORTCUTS }
  };
})(typeof self !== 'undefined' ? self : this);
