/* app.js — Bill Bench UI. Rules live in bills-engine.js (a verbatim port of demo.py); this file only does
   import → state → views → export. No dependencies; the only network requests are the web fonts and the optional model call —
   Claude, OpenAI, Gemini or an OpenAI-compatible endpoint through llm.js (key in memory only). */
(() => {
'use strict';
const E = window.BillsEngine;
const TPL = window.BILL_TEMPLATES;
const CATEGORIES = [...new Set(E.MERCHANTS.map(m => m[1]))].filter(c => c !== 'Uncategorised').sort();
const REASON_KEYS = [
  ['unmapped', 'unmapped merchant', r => r === 'unmapped merchant'],
  ['high', 'high amount', r => r.startsWith('high amount')],
  ['exactdup', 'exact duplicate', r => r.startsWith('exact duplicate of')],
  ['possibledup', 'possible duplicate', r => r.startsWith('possible duplicate of')],
  ['missingdate', 'missing date', r => r === 'missing date'],
  ['missingamount', 'missing amount', r => r === 'missing amount'],
  ['invalidamount', 'invalid amount', r => r.startsWith('invalid amount')],
  ['invaliddate', 'invalid date', r => r === 'invalid date'],
  ['ambiguousdate', 'ambiguous date', r => r.startsWith('ambiguous date')],
  ['reviewer', 'reviewer decision', r => r.endsWith('by reviewer')],
];
const reasonKey = r => (REASON_KEYS.find(([, , f]) => f(r)) || ['other'])[0];
const reasonLabel = k => (REASON_KEYS.find(([key]) => key === k) || [k, k])[1];

/* ---------- tiny DOM / format helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SVG_TAGS = new Set(['svg', 'rect', 'line', 'text', 'defs', 'pattern', 'path', 'g', 'title', 'circle', 'polyline']);
const h = (tag, attrs = {}, ...kids) => {
  const el = SVG_TAGS.has(tag) ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (v === null || v === undefined || v === false) continue; if (k === 'class') el.setAttribute('class', v); else if (k === 'html') el.innerHTML = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (k === 'dataset') Object.assign(el.dataset, v); else el.setAttribute(k, v === true ? '' : v); }
  for (const kid of kids.flat(Infinity)) { if (kid === null || kid === undefined || kid === false) continue; el.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
  return el;
};
const money = (cents, dash = '—') => cents === null || cents === undefined ? dash : E.moneyStr(cents, true);
const srcLabel = id => { const [s, r] = id.split(':'); return 'ABC'[s - 1] + ':' + r; };
const chip = (k, v, href) => { const el = h(href ? 'a' : 'span', { class: 'chip', href, translate: 'no' }, k + ' ', h('b', {}, v)); return el; };
const srcChip = (id, link = true) => chip('src', srcLabel(id), link ? `#/bills?i=${encodeURIComponent(id)}&excluded=1` : null);
const tag = (kind, text) => h('span', { class: 'tag tag-' + kind }, text);
const statusTag = r => r.status === 'clean' ? (r.reasons.length ? tag('warning', 'Needs review') : tag('success', 'Retained')) : r.status === 'duplicate' ? tag('neutral', 'Excluded · duplicate') : r.status === 'excluded' ? tag('neutral', 'Excluded by reviewer') : tag('danger', 'Unparseable');
const nowIso = () => new Date().toISOString();
const hhmm = iso => iso ? iso.slice(11, 16) : '—';
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const download = (name, bytes, type) => { const a = h('a', { href: URL.createObjectURL(new Blob([bytes], { type })), download: name }); document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); };

/* ---------- persistence (IndexedDB, one record) ---------- */
const DB = {
  open() { return new Promise((res, rej) => { const r = indexedDB.open('bill-bench', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async get(k) { try { const db = await this.open(); return await new Promise((res, rej) => { const t = db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); } catch (e) { return undefined; } },
  async set(k, v) { try { const db = await this.open(); await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite').objectStore('kv').put(v, k); t.onsuccess = res; t.onerror = () => rej(t.error); }); } catch (e) { /* private mode etc.: keep working without persistence */ } },
  async clear() { try { const db = await this.open(); await new Promise((res, rej) => { const t = db.transaction('kv', 'readwrite').objectStore('kv').clear(); t.onsuccess = res; t.onerror = () => rej(t.error); }); } catch (e) {} },
};

/* ---------- state ---------- */
const S = { source: null, rows: null, rules: { aliases: [], threshold: E.DEFAULT_HIGH_CENTS }, pending: null, decisions: [], suggestions: {}, suggestMeta: null, checks: null,
  ui: { autoAdvance: true, sort: 'source', navCollapsed: false, inspectorOpen: false, seenStart: false, page: 0 }, apiKey: null,
  llm: { provider: 'anthropic', model: 'claude-sonnet-5', baseUrl: '' } };
let cache = null, saveTimer = null;
const invalidate = () => { cache = null; };
const persist = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => DB.set('state', { source: S.source, rows: S.rows, rules: S.rules, decisions: S.decisions, ui: { autoAdvance: S.ui.autoAdvance, sort: S.ui.sort, navCollapsed: S.ui.navCollapsed, seenStart: S.ui.seenStart }, savedAt: nowIso() }), 150); };
const extraRules = () => { const aliases = {}, categories = {}; for (const r of S.rules.aliases) { aliases[r.alias.toLowerCase().replace(/[^a-z0-9]/g, '')] = r.alias.trim(); categories[r.alias.trim()] = r.category; } return { aliases, categories }; };
const uid = () => Math.random().toString(36).slice(2, 10);

function buildModel(rules = S.rules, decisions = S.decisions) {
  const extra = { aliases: {}, categories: {} };
  for (const r of rules.aliases) { extra.aliases[r.alias.toLowerCase().replace(/[^a-z0-9]/g, '')] = r.alias.trim(); extra.categories[r.alias.trim()] = r.category; }
  const base = E.clean(S.rows, rules.threshold, extra);
  const recs = base.records.map(r => ({ ...r, reasons: [...r.reasons], decided: null, decidedAt: null }));
  const byId = Object.fromEntries(recs.map(r => [r.id, r]));
  const userChanges = [];
  for (const d of decisions) {
    if (d.undoneBy) continue;
    if (d.action === 'undo') { userChanges.push({ id: d.rowId, field: 'decision', before: d.before, after: 'undone', rule: 'reviewer undo', who: 'you', at: d.at, did: d.id }); continue; }
    const r = byId[d.rowId]; if (!r) continue;
    r.decided = d.action; r.decidedAt = d.at;
    if (d.action === 'category') { userChanges.push({ id: r.id, field: 'category', before: r.category, after: d.after, rule: d.rule || 'manual review', who: 'you', at: d.at, did: d.id }); r.category = d.after; r.reasons = r.reasons.filter(x => x !== 'unmapped merchant'); }
    else if (d.action === 'duplicate') { userChanges.push({ id: r.id, field: 'disposition', before: r.status, after: 'duplicate', rule: 'marked duplicate by reviewer', who: 'you', at: d.at, did: d.id }); r.status = 'duplicate'; r.duplicate_of = d.after; r.reasons.push('marked duplicate of ' + d.after + ' by reviewer'); }
    else if (d.action === 'exclude') { userChanges.push({ id: r.id, field: 'disposition', before: r.status, after: 'excluded', rule: 'excluded by reviewer', who: 'you', at: d.at, did: d.id }); r.status = 'excluded'; r.reasons.push('excluded by reviewer'); }
    else if (d.action === 'confirm') { userChanges.push({ id: r.id, field: 'review', before: 'flagged', after: 'confirmed as is', rule: 'reviewer confirmation', who: 'you', at: d.at, did: d.id }); }
  }
  const statuses = ['clean', 'duplicate', 'unparseable', 'excluded'];
  const counts = {}, cents = {}; for (const s of statuses) { counts[s] = recs.filter(r => r.status === s).length; cents[s] = recs.filter(r => r.status === s).reduce((a, r) => a + (r.cents || 0), 0); }
  const rec = { count: recs.length, counts, cents, known_input_cents: recs.reduce((a, r) => a + (r.cents || 0), 0), unknown_amount_rows: recs.filter(r => r.cents === null).length };
  const buildChanges = base.changes.map(c => ({ ...c, who: c.rule === 'reviewer alias rule' ? 'you' : 'build' }));
  const flagged = recs.filter(r => r.reasons.length || r.decided);
  return { base, records: recs, byId, reconciliation: rec, changes: buildChanges, userChanges, flagged, decidedCount: flagged.filter(r => r.decided).length,
    bills: recs.filter(r => r.status === 'clean'), dups: recs.filter(r => r.status === 'duplicate'), possible: recs.filter(r => r.reasons.some(x => x.startsWith('possible duplicate of'))),
    high: rules.threshold };
}
const M = () => cache || (cache = buildModel());

/* ---------- checks (browser version of `demo.py check`) ---------- */
function runChecks() {
  const m = M(); const items = [];
  const ids = m.records.map(r => r.id);
  items.push(['every output row points to a source', ids.length === S.rows.length && new Set(ids).size === ids.length, `${ids.length} rows, ${new Set(ids).size} unique ids`]);
  const total = Object.values(m.reconciliation.counts).reduce((a, b) => a + b, 0);
  items.push(['partitions are disjoint', total === m.records.length && m.records.every(r => ['clean', 'duplicate', 'unparseable', 'excluded'].includes(r.status)), Object.entries(m.reconciliation.counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(' + ') + ` = ${total}`]);
  const sum = Object.values(m.reconciliation.cents).reduce((a, b) => a + b, 0);
  items.push(['known amounts reconcile to the cent', sum === m.reconciliation.known_input_cents, `${money(sum)} = ${money(m.reconciliation.known_input_cents)}; ${m.reconciliation.unknown_amount_rows} unknown kept out`]);
  const review = m.records.filter(r => r.reasons.length).length;
  items.push(['review sheet = flagged rows', review === E.workbookTables(exportModel())['Needs review'].length, `${review} flagged`]);
  items.push(['change log covers every edit', m.changes.length === m.base.changes.length && m.userChanges.length === S.decisions.filter(d => !d.undoneBy).length, `${m.changes.length} build + ${m.userChanges.length} yours`]);
  const a = E.pyJson(E.clean(S.rows, S.rules.threshold, extraRules())), b = E.pyJson(E.clean(S.rows, S.rules.threshold, extraRules()));
  items.push(['rebuild twice → identical', a === b, `${a.length} chars each`]);
  S.checks = { at: nowIso(), items: items.map(([name, ok, detail]) => ({ name, ok: !!ok, detail })) };
  return S.checks;
}

/* ---------- export ---------- */
function exportModel() {
  const m = M();
  const records = m.records.map(r => { const { decided, decidedAt, ...rest } = r; return rest; });
  return { records, changes: m.base.changes, reconciliation: m.reconciliation, seed: S.source?.kind === 'sample' ? S.source.seed : null, high_amount_cents: S.rules.threshold };
}
function exportTables() {
  const em = exportModel(); const m = M();
  const rec3 = { ...em.reconciliation, counts: { clean: em.reconciliation.counts.clean, duplicate: em.reconciliation.counts.duplicate, unparseable: em.reconciliation.counts.unparseable }, cents: { clean: em.reconciliation.cents.clean, duplicate: em.reconciliation.cents.duplicate, unparseable: em.reconciliation.cents.unparseable } };
  const tables = E.workbookTables({ ...em, reconciliation: rec3 });
  const exc = em.reconciliation.counts.excluded || 0;
  if (exc) { // add a reviewer-exclusion line so the control total still reconciles; the difference formula widens by one term
    const bad = m.records.filter(r => r.reasons.length).length;
    tables['Summary'].splice(3, 0, ['Excluded by reviewer', { formula: `SUMIFS('Needs review'!H5:H${bad + 4},'Needs review'!B5:B${bad + 4},"excluded")`, value: new E.PyFloat(em.reconciliation.cents.excluded / 100) }, exc, 'Removed from Bills by a reviewer decision; amount kept in the control total.']);
    tables['Summary'][5] = ['Reconciliation difference', { formula: '(ROUND(B5*100,0)+ROUND(B6*100,0)+ROUND(B7*100,0)+ROUND(B8*100,0)-ROUND(B9*100,0))/100', value: 0 }, null, 'Exact cents; must equal zero. Missing amounts stay unknown.'];
  }
  if (m.userChanges.length) tables['Change log'] = tables['Change log'].concat(m.userChanges.map(c => [c.id, c.field, c.before, c.after, c.rule + ' (you, ' + c.at.slice(0, 16).replace('T', ' ') + ')', m.byId[c.id]?.source_file ?? '', m.byId[c.id]?.source_sheet ?? '', m.byId[c.id]?.source_row ?? null]));
  return tables;
}
async function exportWorkbook() { return E.writeZip(E.fill(await E.readZip(b64(TPL.output)), exportTables())); }
function exportLedger() { const em = exportModel(); const pure = !S.decisions.length && !S.rules.aliases.length; return E.pyJson(pure ? em : { ...em, decisions: S.decisions, reviewer_rules: S.rules.aliases, exported_at: nowIso() }) + '\n'; }
async function exportInput() { if (S.source?.kind === 'sample') return E.writeZip(E.fill(await E.readZip(b64(TPL.input)), E.generate(S.source.seed))); return null; }

/* ---------- import: sample, xlsx (strict demo layout or tolerant header mapping), csv ---------- */
async function loadSample(seed = 42) {
  const dirty = E.writeZip(E.fill(await E.readZip(b64(TPL.input)), E.generate(seed)));
  const rows = E.readInput(E.parseWorkbook(await E.readZip(dirty)), 'dirty-input.xlsx');
  setData(rows, { kind: 'sample', seed });
}
const HEADER_WORDS = { invoice: ['invoice', 'bill id', 'reference', 'ref', 'id', 'number', 'no'], merchant: ['merchant', 'vendor', 'payee', 'supplier', 'name', 'description'], date: ['date', 'billed on', 'invoice date', 'posted'], amount: ['amount', 'total', 'gross', 'cad', 'value', 'sum'] };
function mapSheet(rows) { // rows: {rownum: values[]} → header row index + column map, or null
  for (const rn of Object.keys(rows).map(Number).sort((a, b) => a - b).slice(0, 5)) {
    const vals = (rows[rn] || []).map(v => v === null || typeof v === 'object' ? '' : String(v).trim().toLowerCase());
    const pick = key => vals.findIndex(v => v && HEADER_WORDS[key].some(w => v === w || v.includes(w)));
    const cols = { invoice: pick('invoice'), merchant: pick('merchant'), date: pick('date'), amount: pick('amount') };
    if (cols.merchant >= 0 && cols.date >= 0 && cols.amount >= 0 && new Set(Object.values(cols).filter(x => x >= 0)).size === Object.values(cols).filter(x => x >= 0).length) return { headerRow: rn, cols, headers: rows[rn].map(v => v === null ? '' : String(v)) };
  }
  return null;
}
function tolerantRows(workbook, filename) {
  const out = [], report = [];
  let si = 0;
  for (const [sheet, rows] of Object.entries(workbook)) {
    si++; const map = mapSheet(rows);
    if (!map) { report.push({ sheet, ok: false, headers: (rows[Object.keys(rows).map(Number).sort((a, b) => a - b)[0]] || []).map(v => v === null || typeof v === 'object' ? '' : String(v)).filter(Boolean) }); continue; }
    const headers = ['invoice', 'merchant', 'date', 'amount'].map(k => map.cols[k] >= 0 ? map.headers[map.cols[k]] : '(none)');
    let n = 0;
    for (const rn of Object.keys(rows).map(Number).sort((a, b) => a - b)) {
      if (rn <= map.headerRow) continue;
      const v = rows[rn]; const cell = i => i >= 0 && v[i] !== null && v[i] !== undefined ? (typeof v[i] === 'object' ? '' : String(v[i])) : '';
      if (!cell(map.cols.merchant) && !cell(map.cols.date) && !cell(map.cols.amount)) continue;
      out.push({ id: `${si}:${rn}`, raw: [cell(map.cols.invoice) || `ROW-${si}-${rn}`, cell(map.cols.merchant), cell(map.cols.date), cell(map.cols.amount)], source_file: filename, source_sheet: sheet, source_row: rn, headers }); n++;
    }
    report.push({ sheet, ok: true, headers, n });
  }
  return { rows: out, report };
}
function parseCsv(text) { const rows = {}; let i = 0, rn = 0; const lines = []; let cur = [], field = '', q = false;
  for (const ch of text) { if (q) { if (ch === '"') { q = false; } else field += ch; } else if (ch === '"') q = true; else if (ch === ',') { cur.push(field); field = ''; } else if (ch === '\n') { cur.push(field); lines.push(cur); cur = []; field = ''; } else if (ch !== '\r') field += ch; }
  if (field || cur.length) { cur.push(field); lines.push(cur); }
  for (const l of lines) { rn++; if (l.some(x => x !== '')) rows[rn] = l.map(x => x === '' ? null : x); i++; }
  return rows; }
async function importFile(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let workbook, strictErr = null;
  if (/\.csv$/i.test(file.name)) workbook = { [file.name.replace(/\.csv$/i, '')]: parseCsv(new TextDecoder().decode(bytes)) };
  else workbook = E.parseWorkbook(await E.readZip(bytes));
  try { const rows = E.readInput(workbook, file.name); setData(rows, { kind: 'file', name: file.name, layout: 'demo layout (strict, identical to the CLI reader)' }); return { ok: true, strict: true }; } catch (e) { strictErr = e.message; }
  const { rows, report } = tolerantRows(workbook, file.name);
  if (!rows.length) return { ok: false, report, strictErr };
  setData(rows, { kind: 'file', name: file.name, layout: 'header mapping: ' + report.filter(r => r.ok).map(r => `${r.sheet} → ${r.headers.join(' / ')}`).join('; ') });
  return { ok: true, strict: false, report };
}
function setData(rows, source) { S.rows = rows; S.source = source; S.decisions = []; S.suggestions = {}; S.suggestMeta = null; S.checks = null; S.rules = { aliases: [], threshold: E.DEFAULT_HIGH_CENTS }; S.pending = null; invalidate(); persist(); }

/* ---------- decisions ---------- */
function decide(rowId, action, extra = {}) {
  const d = { id: uid(), rowId, action, at: nowIso(), ...extra };
  S.decisions.push(d); invalidate(); persist(); return d;
}
function undoDecision(did) {
  const d = S.decisions.find(x => x.id === did); if (!d || d.undoneBy) return;
  const u = { id: uid(), rowId: d.rowId, action: 'undo', before: d.action, of: did, at: nowIso() };
  d.undoneBy = u.id; S.decisions.push(u);
  if (d.ruleAdded) { S.rules.aliases = S.rules.aliases.filter(r => r.id !== d.ruleAdded); }
  invalidate(); persist();
}
function rowsMatchingAlias(alias) { const key = alias.toLowerCase().replace(/[^a-z0-9]/g, ''); return S.rows.filter(r => r.raw[1].toLowerCase().replace(/[^a-z0-9]/g, '') === key || r.raw[1].trim() === alias.trim()).length; }

/* ---------- routing ---------- */
const route = () => { const raw = location.hash.replace(/^#\/?/, ''); const [path, qs] = raw.split('?'); const p = new URLSearchParams(qs || ''); return { view: path || '', p }; };
const go = (view, params = {}) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') p.set(k, v); location.hash = '#/' + view + (p.toString() ? '?' + p : ''); };
const setParam = (k, v) => { const r = route(); const o = Object.fromEntries(r.p); if (v === null || v === undefined || v === '') delete o[k]; else o[k] = v; go(r.view, o); };

/* ---------- toasts / dialogs ---------- */
function toast(msg, { undo, ms, kind } = {}) {
  const box = $('#toasts'); const el = h('div', { class: 'toast enter', role: kind === 'error' ? 'alert' : 'status' }, h('span', {}, msg));
  if (undo) el.append(h('button', { class: 'btn btn-sm', onclick: () => { undo(); el.remove(); } }, 'Undo'));
  el.append(h('button', { class: 'btn btn-ghost btn-sm', 'aria-label': 'Dismiss', onclick: () => el.remove() }, '×'));
  box.append(el); requestAnimationFrame(() => el.classList.remove('enter'));
  while (box.children.length > 3) box.firstChild.remove();
  let t = setTimeout(() => { el.classList.add('leave'); setTimeout(() => el.remove(), 200); }, ms || (undo ? 8000 : 4000));
  el.addEventListener('mouseenter', () => clearTimeout(t)); el.addEventListener('mouseleave', () => { t = setTimeout(() => el.remove(), 3000); });
}
// A dialog settles on its own form's submit, its Cancel button, Esc or close, whichever comes first. Relying on the close event
// alone left OK dead in Chrome after the dialog had once been closed with Esc: it fired no close event again (Callback Desk
// round-1 audit, 2026-09-16; this helper is the same one).
function dialog(title, body, { ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  return new Promise(res => {
    const d = $('#dlg'); d.innerHTML = ''; const opener = document.activeElement, off = new AbortController(); let settled = false;
    const settle = yes => { if (settled) return; settled = true; off.abort(); if (d.open) d.close(yes ? 'ok' : 'cancel'); res(yes); opener && opener.focus && opener.focus(); };
    const form = h('form', { method: 'dialog' }, h('h2', {}, title), typeof body === 'string' ? h('p', { class: 'muted' }, body) : body,
      h('div', { class: 'acts' }, cancel && h('button', { class: 'btn', value: 'cancel', type: 'button', onclick: () => settle(false) }, cancel), h('button', { class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), value: 'ok', type: 'submit' }, ok)));
    form.addEventListener('submit', e => { e.preventDefault(); settle(true); }, { signal: off.signal });
    d.addEventListener('cancel', e => { e.preventDefault(); settle(false); }, { signal: off.signal });
    d.addEventListener('close', () => settle(d.returnValue === 'ok'), { signal: off.signal });
    d.append(form); d.showModal();
  });
}
function helpDialog() {
  const rows = [['j / k', 'next / previous row in the queue'], ['a', 'Confirm as is'], ['c', 'Set category'], ['d', 'Mark duplicate of…'], ['x', 'Exclude'], ['u', 'Undo last decision'], ['Enter', 'Open in inspector'], ['Esc', 'Close inspector / drawer'], ['?', 'This help']];
  dialog('Keyboard shortcuts', h('div', {}, h('table', {}, rows.map(([k, v]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', { class: 'muted' }, v)))), h('p', { class: 'muted', style: 'margin-top:12px' }, 'Single-key shortcuts only work while the review queue has focus and no text field is active.')), { ok: 'Close', cancel: null });
}

/* ---------- shared UI pieces ---------- */
function overviewPlate(m, open) {
  // Signature panel (design system v3.1): page title and reconciliation bar share one band-coloured plate.
  const rec = m.reconciliation, total = rec.count || 1;
  const segs = [['clean', 'Retained in Bills', 'var(--point)'], ['duplicate', 'Exact duplicates excluded', 'var(--viz-seq-300)'], ['unparseable', 'Unable to parse completely', 'var(--viz-seq-150)'], ['excluded', 'Excluded by reviewer', 'var(--viz-seq-250)']].filter(([k]) => rec.counts[k]);
  const known = Object.values(rec.cents).reduce((a, b) => a + b, 0), ok = known === rec.known_input_cents;
  const eqRows = segs.map(([k]) => rec.counts[k]).join(' + ') + ' = ' + rec.count + ' rows';
  const eqCad = segs.map(([k]) => money(rec.cents[k])).join(' + ') + ' = ' + money(rec.known_input_cents);
  return h('section', { class: 'plate', 'aria-labelledby': 'plate-title' }, h('div', { class: 'plate-in' },
    h('div', {},
      h('div', { class: 'plate-head' }, h('span', { class: 'eyebrow' }, 'Overview'), chip('seed', S.source.kind === 'sample' ? S.source.seed : 'file'), chip('threshold', 'CAD ' + E.thresholdLabel(S.rules.threshold)), h('a', { class: 'btn btn-primary', href: '#/review' }, `Start review (${open})`)),
      h('h1', { id: 'plate-title', class: 'display' }, `Where the ${rec.count} input rows went`),
      h('p', { class: 'lede' }, 'Merchant rules set each category, exact duplicates are set aside, and uncertain rows stay in view until someone decides.'),
      h('div', { class: 'rule', 'aria-hidden': 'true' })),
    h('div', { role: 'group', 'aria-label': `Where the ${rec.count} input rows went` },
      h('div', { class: 'sum-bar', 'aria-hidden': 'true' }, segs.map(([k, , c]) => h('span', { style: `width:${rec.counts[k] / total * 100}%;background:${c}` })), rec.unknown_amount_rows ? h('span', { class: 'hatch', style: `width:${rec.unknown_amount_rows / total * 100}%`, title: 'rows whose amount is unknown (counted in a partition above; shown again here)' }) : null),
      h('div', { class: 'sum-legend' }, segs.map(([k, l, c]) => h('span', {}, h('i', { style: 'background:' + c }), l + ' ', h('b', { class: 'mono' }, rec.counts[k]))), h('span', {}, h('i', { class: 'hatch' }), 'Amount unknown ', h('b', { class: 'mono' }, rec.unknown_amount_rows), ' (kept out of the arithmetic)')),
      h('div', { class: 'sum-eq' }, eqRows + ' · CAD ' + eqCad + ' ', h('span', { class: ok ? 'ok' : 'bad' }, ok ? '✓ reconciles to the cent' : `✗ off by ${money(known - rec.known_input_cents)}`)),
      h('p', { class: 'caption' }, 'One row can count twice in the review reasons; the totals above are reconciled independently of category.'))));
}
function reasonCounts(m) { const c = {}; for (const r of m.records) for (const key of new Set(r.reasons.map(reasonKey))) c[key] = (c[key] || 0) + 1; return c; }
function beforeAfter(r, m) {
  const ch = m.changes.filter(c => c.id === r.id && c.field !== 'header' && c.field !== 'disposition').concat(m.userChanges.filter(c => c.id === r.id));
  return h('table', { class: 'ba' }, h('thead', {}, h('tr', {}, h('th', {}, 'field'), h('th', {}, 'before'), h('th', {}, 'after'), h('th', {}, 'rule'))),
    h('tbody', {}, ch.length ? ch.map(c => h('tr', {}, h('td', {}, c.field), h('td', { class: 'mono' }, JSON.stringify(c.before)), h('td', { class: 'mono changed' }, JSON.stringify(c.after)), h('td', {}, c.rule + (c.who === 'you' ? ' · you' : '')))) : h('tr', {}, h('td', { colspan: 4, class: 'muted' }, 'no changes — row was already clean'))));
}
function reasonsList(r) { return h('span', { class: 'reasons' }, r.reasons.map(x => h('span', { class: 'reason', title: x }, x.length > 42 ? x.slice(0, 40) + '…' : x))); }
function queueOrder(m) { const q = m.flagged.slice(); if (S.ui.sort === 'amount') q.sort((a, b) => Math.abs(b.cents ?? -1) - Math.abs(a.cents ?? -1)); const undecided = q.filter(r => !r.decided), decided = q.filter(r => r.decided); return undecided.concat(decided); }
function filteredQueue(m, key) { return queueOrder(m).filter(r => !key || key === 'all' || r.reasons.some(x => reasonKey(x) === key) || (r.decided && key === 'decided')); }

/* ---------- inspector ---------- */
function renderInspector(m, r, ctx) {
  const box = $('#inspector'); box.innerHTML = '';
  if (!S.rows || !r) { box.append(h('div', { class: 'insp-head' }, h('h2', {}, 'Inspector'), h('button', { class: 'btn btn-ghost btn-icon', 'aria-label': 'Close inspector', onclick: () => { S.ui.inspectorOpen = false; render(); } }, '×')), h('div', { class: 'insp-empty' }, ctx?.emptyText || 'Select a row to see its source, every change made to it and the actions you can take.')); return; }
  const idx = ctx?.queue ? ctx.queue.indexOf(r) : -1;
  box.append(h('div', { class: 'insp-head' }, srcChip(r.id, false), statusTag(r), h('h2', { tabindex: '-1', id: 'insp-title' }, r.merchant || '(no merchant)'), h('span', { class: 'spacer' }), h('button', { class: 'btn btn-ghost btn-icon', 'aria-label': 'Close inspector', onclick: () => { S.ui.inspectorOpen = false; setParam('i', null); } }, '×')));
  const body = h('div', { class: 'insp-body' });
  if (idx >= 0) body.append(h('div', { class: 'review-card head' }, h('span', {}, r.decided ? `decided · ${r.decided}` : 'needs a decision'), h('span', { class: 'pos' }, `${idx + 1} of ${ctx.queue.length}`)));
  body.append(h('div', { class: 'review-card' }, h('div', { class: 'merchant' }, r.merchant), r.raw[1] !== r.merchant ? h('div', { class: 'raw' }, '← raw: ' + JSON.stringify(r.raw[1])) : null,
    h('div', { class: 'line' }, (r.date || '— missing date') + ' · ' + (r.cents === null ? 'amount unknown' : 'CAD ' + money(r.cents)) + ' · ' + r.category + (r.status === 'duplicate' ? ' · duplicate of ' + srcLabel(r.duplicate_of || '?') : '')),
    r.reasons.length ? h('div', {}, h('span', { class: 'faint', style: 'font-size:var(--text-xs)' }, 'Reasons: '), reasonsList(r)) : null));
  body.append(h('section', {}, h('h3', {}, 'Source'), h('dl', { class: 'kv' }, h('dt', {}, 'file'), h('dd', { class: 'mono' }, r.source_file), h('dt', {}, 'sheet'), h('dd', {}, r.source_sheet + ' · row ' + r.source_row), h('dt', {}, 'raw'), h('dd', { class: 'mono', style: 'font-size:var(--text-2xs)' }, r.raw.map(x => JSON.stringify(x)).join(' · ')))));
  body.append(h('section', {}, h('h3', {}, 'Before → after'), beforeAfter(r, m)));
  const sg = S.suggestions[r.id];
  if (sg) body.append(h('section', {}, h('h3', {}, 'Suggestion'), h('div', { class: 'suggest' }, h('span', {}, sg.category ? h('b', {}, sg.category) : 'no suggestion', sg.category ? h('span', { class: 'muted' }, ` · ${sg.mode === 'model' ? sg.model : 'simulated'} · ${sg.reason}`) : h('span', { class: 'muted' }, ' · ' + sg.reason)),
    sg.category && !r.decided ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => applyCategory(r, sg.category, false, sg.mode === 'model' ? 'suggestion (' + sg.model + ') accepted by you' : 'simulated suggestion accepted by you', ctx) }, 'Accept') : null,
    h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { delete S.suggestions[r.id]; render(); } }, 'Dismiss'))));
  const hist = S.decisions.filter(d => d.rowId === r.id);
  if (hist.length) body.append(h('section', {}, h('h3', {}, 'History'), h('ul', { class: 'checks' }, hist.map(d => h('li', { class: d.undoneBy ? 'na' : 'ok' }, h('span', { class: 'mono' }, hhmm(d.at)), h('span', {}, d.action === 'undo' ? `undid ${d.before}` : d.action + (d.after ? ' → ' + d.after : '') + (d.undoneBy ? ' (undone)' : '')))))));
  box.append(body);
  if (!r.decided && r.status !== 'excluded' && ctx?.actions !== false) box.append(reviewActions(r, m, ctx));
  else if (r.decided) box.append(h('div', { class: 'insp-foot' }, h('button', { class: 'btn', onclick: () => { const d = S.decisions.filter(x => x.rowId === r.id && !x.undoneBy && x.action !== 'undo').pop(); if (d) { undoDecision(d.id); toast('Decision undone'); render(); } } }, 'Undo decision')));
}
function applyCategory(r, category, addRule, rule, ctx) {
  const m = M(); let ruleId = null, affected = 0;
  if (addRule) { ruleId = uid(); affected = rowsMatchingAlias(r.merchant); S.rules.aliases.push({ id: ruleId, alias: r.merchant, category, who: 'you', at: nowIso() }); }
  const d = decide(r.id, 'category', { before: r.category, after: category, rule: rule || 'manual review', ruleAdded: ruleId });
  toast(`Category set to ${category}` + (addRule ? ` · rule added, ${plural(affected, 'row')} affected` : ''), { undo: () => { undoDecision(d.id); render(); } });
  afterDecision(ctx, r);
}
function afterDecision(ctx, r) {
  if (ctx?.queue && S.ui.autoAdvance) { const next = ctx.queue.slice(ctx.queue.indexOf(r) + 1).find(x => !x.decided) || ctx.queue.find(x => !x.decided && x !== r); setParam('i', next ? next.id : null); }
  else render();
}
function reviewActions(r, m, ctx) {
  const foot = h('div', { class: 'insp-foot' });
  const sel = h('select', { 'aria-label': 'Category' }, CATEGORIES.map(c => h('option', { value: c, selected: c === r.category && r.category !== 'Uncategorised' }, c)));
  const addRule = h('input', { type: 'checkbox', id: 'add-rule' });
  const catBox = h('div', { class: 'field', style: 'flex-basis:100%', hidden: true }, h('div', { class: 'rule-edit' }, sel, h('button', { class: 'btn btn-sm btn-primary', onclick: () => applyCategory(r, sel.value, addRule.checked, 'manual review', ctx) }, 'Apply')),
    h('label', { class: 'check', for: 'add-rule' }, addRule, `also add rule "${r.merchant} → …" (affects ${plural(rowsMatchingAlias(r.merchant), 'row')})`));
  const dupBox = h('div', { class: 'field', style: 'flex-basis:100%', hidden: true });
  const dupSel = h('select', { 'aria-label': 'Duplicate of' }, m.bills.filter(x => x.id !== r.id && x.merchant === r.merchant).concat(m.bills.filter(x => x.id !== r.id && x.merchant !== r.merchant)).slice(0, 300).map(x => h('option', { value: x.id }, `${srcLabel(x.id)} · ${x.invoice} · ${x.date || '—'} · ${money(x.cents)}`)));
  dupBox.append(h('div', { class: 'rule-edit' }, dupSel, h('button', { class: 'btn btn-sm btn-primary', onclick: () => { const d = decide(r.id, 'duplicate', { before: r.status, after: dupSel.value }); toast(`Marked as duplicate of ${srcLabel(dupSel.value)} · excluded from Bills`, { undo: () => { undoDecision(d.id); render(); } }); afterDecision(ctx, r); } }, 'Apply')));
  foot.append(...[
    h('button', { class: 'btn btn-primary', 'data-key': 'a', title: 'Confirm as is (a)', onclick: () => { const d = decide(r.id, 'confirm', {}); toast('Confirmed as is', { undo: () => { undoDecision(d.id); render(); } }); afterDecision(ctx, r); } }, 'Confirm as is'),
    h('button', { class: 'btn', 'data-key': 'c', title: 'Set category (c)', onclick: () => { catBox.hidden = !catBox.hidden; dupBox.hidden = true; if (!catBox.hidden) sel.focus(); } }, 'Set category ▾'),
    r.status === 'clean' ? h('button', { class: 'btn', 'data-key': 'd', title: 'Mark duplicate of… (d)', onclick: () => { dupBox.hidden = !dupBox.hidden; catBox.hidden = true; if (!dupBox.hidden) dupSel.focus(); } }, 'Duplicate of…') : null,
    h('button', { class: 'btn', 'data-key': 'x', title: 'Exclude from Bills (x)', onclick: () => { const d = decide(r.id, 'exclude', { before: r.status, after: 'excluded' }); toast('Excluded from Bills · amount kept in the control total', { undo: () => { undoDecision(d.id); render(); } }); afterDecision(ctx, r); } }, 'Exclude'),
    ctx?.queue ? h('button', { class: 'btn btn-ghost', onclick: () => { const next = ctx.queue.slice(ctx.queue.indexOf(r) + 1).find(x => !x.decided); if (next) setParam('i', next.id); else toast('No more undecided rows'); } }, 'Skip →') : null,
    catBox, dupBox, h('div', { class: 'keys', style: 'flex-basis:100%' }, 'keys: ', h('kbd', {}, 'j'), ' ', h('kbd', {}, 'k'), ' ', h('kbd', {}, 'a'), ' ', h('kbd', {}, 'c'), ' ', h('kbd', {}, 'd'), ' ', h('kbd', {}, 'x'), ' ', h('kbd', {}, 'u'), ' · ', h('kbd', {}, '?'))].filter(Boolean));
  return foot;
}

/* ---------- views ---------- */
function viewLanding(main) {
  const has = !!S.rows;
  const drop = h('div', { class: 'drop', ondragover: e => { e.preventDefault(); drop.classList.add('over'); }, ondragleave: () => drop.classList.remove('over'), ondrop: e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) doImport(f); } });
  const input = h('input', { type: 'file', accept: '.xlsx,.csv', hidden: true, onchange: e => { const f = e.target.files[0]; if (f) doImport(f); e.target.value = ''; } });
  const canFile = 'File' in window && 'DecompressionStream' in window;
  drop.append(h('p', {}, canFile ? 'Drop an .xlsx or .csv here, or ' : 'Your browser can\'t read local files here; the sample still works. ', canFile ? h('button', { class: 'btn btn-sm', onclick: () => input.click() }, 'Choose a file…') : null, input),
    h('p', {}, 'Expected: up to a few sheets, headers like ', h('code', {}, 'Date / Merchant / Amount'), ' within the first 5 rows. Parsed in this tab, never uploaded.'),
    h('p', {}, 'Not supported: Excel serial dates, PDFs, macros, USD amounts, more than ~2,000 rows per sheet.'));
  const seed = h('input', { type: 'number', value: '42', min: '0', max: '999999', style: 'width:6.5em', 'aria-label': 'seed' });
  main.append(h('div', { class: 'landing' },
    has ? h('div', { class: 'card' }, h('h2', {}, 'Data is loaded'), h('p', { class: 'hint' }, `${S.rows.length} rows from ${S.source.kind === 'sample' ? 'the synthetic sample (seed ' + S.source.seed + ')' : S.source.name}. Importing another file replaces it and clears your decisions.`), h('div', { class: 'toolbar', style: 'margin-top:12px' }, h('a', { class: 'btn btn-primary', href: '#/overview' }, 'Back to overview'), h('button', { class: 'btn btn-ghost', onclick: clearAll }, 'Clear all data'))) : null,
    h('div', {}, h('h1', {}, 'Turn a year of messy bills into a reconciled five-sheet workbook.'), h('p', { class: 'lede', style: 'margin-top:8px' }, 'Files are parsed in this tab and never uploaded. Uncertain rows are shown, not guessed.')),
    h('div', { class: 'toolbar' }, h('button', { class: 'btn btn-primary', onclick: () => doSample(parseInt(seed.value, 10) || 42) }, has ? 'Load another synthetic sample' : 'Load the sample workbook · 125 synthetic rows'), h('label', { class: 'check' }, 'seed ', seed)),
    drop,
    h('div', { class: 'steps' }, [['1 Import', 'read up to 3 sheets'], ['2 Clean & flag', 'normalise, classify, find duplicates'], ['3 Review', 'decide the flagged rows'], ['4 Export', 'five sheets that reconcile to the cent']].map(([a, b]) => h('div', {}, h('b', {}, a), b))),
    h('p', { class: 'refuse' }, 'What it refuses to guess: ', h('code', {}, '03/04/2025'), ' (day/month order unknown) · ', h('code', {}, 'USD 120.00'), ' (unsupported currency) · ', h('code', {}, '=SUM(…)'), ' in a cell (stored as text, never executed).')));
}
async function doSample(seed) { toast('Generating ' + seed + '…', { ms: 1500 }); await loadSample(seed); go('overview'); toast(`Loaded 125 synthetic rows (seed ${seed})`); }
async function doImport(file) {
  if (file.size > 5 * 1024 * 1024 && !(await dialog('Large file', `${(file.size / 1048576).toFixed(1)} MB — this tab may freeze for a few seconds while it parses.`, { ok: 'Continue' }))) return;
  // Parsing runs in one synchronous block (a 40,000-row CSV held the tab for 4.6 s), so a timer set before it can never
  // fire. Files large enough to take visible time show the loading card first and yield once so it paints; small files
  // (the 125-row sample parses in a few milliseconds) never flash it.
  const loading = h('div', { class: 'card loading', role: 'status' }, h('h2', {}, `Reading ${file.name}…`), h('span', { class: 'skel', style: 'width:62%' }), h('span', { class: 'skel', style: 'width:38%' }));
  if (file.size > 100 * 1024) { $('#main').prepend(loading); await new Promise(r => setTimeout(r, 50)); }
  let res; try { res = await importFile(file); } catch (e) { res = { ok: false, strictErr: e.message, report: [] }; }
  // on success the card stays until the overview render replaces it: building the model and view for a large file is
  // the longer part of the wait, and removing the card first would leave a frozen page with nothing on it
  if (res.ok) { go('overview'); toast(`Loaded ${S.rows.length} rows from ${file.name}` + (res.strict ? '' : ' · headers mapped'), { ms: 6000 }); return; }
  loading.remove();
  const main = $('#main'); main.prepend(h('div', { class: 'error', role: 'alert' }, h('h2', {}, `Couldn't read ${file.name}`),
    h('p', {}, res.strictErr ? 'Strict demo layout: ' + res.strictErr + '. ' : '', 'Header mapping: ', res.report && res.report.length ? res.report.map(r => `${r.sheet}: ` + (r.ok ? `ok (${r.headers.join(' / ')})` : `found ${r.headers.slice(0, 6).join(' / ') || 'no text'}, expected Date / Merchant / Amount`)).join('; ') : 'no sheets found'),
    h('div', { class: 'toolbar' }, h('button', { class: 'btn btn-primary', onclick: () => doSample(42) }, 'Load the sample'), h('a', { class: 'btn', href: 'https://github.com/NickkkLian/bill-categoriser#supported-layouts' }, 'Supported layouts'))));
}
async function clearAll() { if (!(await dialog('Clear all data?', 'Removes the loaded rows, your decisions and rules from this browser. Nothing was ever uploaded.', { ok: 'Clear', danger: true }))) return; S.rows = null; S.source = null; S.decisions = []; S.rules = { aliases: [], threshold: E.DEFAULT_HIGH_CENTS }; S.suggestions = {}; S.checks = null; invalidate(); await DB.clear(); if (route().view === '') render(); else go(''); toast('Cleared'); }   // on the import page the address does not change, so nothing redrew it

function viewOverview(main, m) {
  const rec = m.reconciliation, rc = reasonCounts(m), flagged = m.records.filter(r => r.reasons.length).length, checks = S.checks || runChecks();
  main.append(overviewPlate(m, flagged - m.decidedCount > 0 ? flagged - m.decidedCount : 0));
  const cardDefs = [['clean', 'Retained', 'Structurally parseable: a usable date and amount. Retained in Bills; not yet approved for posting.'], ['duplicate', 'Duplicates', 'Exact duplicate: invoice ID, normalised merchant, date and cents all match an earlier row. Excluded once; the original stays.'], ['unparseable', 'Unparseable', 'Missing or malformed date/amount. Kept out of monthly totals; known amounts still count in the control total.'], ['excluded', 'Excluded by reviewer', 'Removed from Bills by a decision in the review queue. Undoable.']];
  main.append(h('div', { class: 'grid', style: 'margin-top:16px' }, cardDefs.filter(([k]) => rec.counts[k] || k !== 'excluded').map(([k, l, def]) => h('button', { class: 'stat', onclick: () => renderInspector(m, null, { emptyText: l + ' — ' + def }) || ($('#inspector').classList.add('open'), S.ui.inspectorOpen = true, $('#shell').classList.remove('no-inspector')) }, h('span', { class: 'lbl' }, l), h('span', { class: 'big' }, rec.counts[k]), h('span', { class: 'amt' }, k === 'unparseable' ? 'known CAD ' + money(rec.cents[k]) : 'CAD ' + money(rec.cents[k])))),
    h('div', { class: 'stat', role: 'group' }, h('span', { class: 'lbl' }, 'Unknown amounts'), h('span', { class: 'big' }, rec.unknown_amount_rows), h('span', { class: 'amt' }, 'kept out of the arithmetic'))));
  const bars = h('div', { class: 'bars' }, Object.entries(rc).sort((a, b) => b[1] - a[1]).map(([k, n]) => h('div', { class: 'b' }, h('span', {}, reasonLabel(k)), h('i', { style: `width:${n / Math.max(...Object.values(rc)) * 100}%` }), h('em', {}, n))));
  main.append(h('div', { class: 'grid-2', style: 'margin-top:16px' },
    h('div', { class: 'card' }, h('h2', {}, 'Review workload'), h('p', { class: 'hint' }, `${flagged} of ${rec.count} rows flagged (${(flagged / rec.count * 100).toFixed(1)}%) · ${m.decidedCount} decided · one row can count twice`), h('div', { style: 'margin:12px 0' }, bars), h('a', { class: 'btn', href: '#/review' }, 'Start review')),
    h('div', { class: 'card' }, h('h2', {}, 'Checks'), h('p', { class: 'hint' }, `${checks.items.filter(c => c.ok).length} of ${checks.items.length} hold · run in this tab at ${hhmm(checks.at)}`), h('ul', { class: 'checks', style: 'margin:12px 0' }, checks.items.map(c => h('li', { class: c.ok ? 'ok' : 'bad', title: c.detail }, h('span', {}, c.name))), h('li', { class: 'na' }, h('span', {}, 'byte-compare with the Python build: not run here — ', h('code', {}, 'python3 -B demo.py check --out <exported folder>')))), h('button', { class: 'btn', onclick: () => { runChecks(); render(); toast('Checks re-run'); } }, 'Re-run checks'))));
  const recent = m.userChanges.slice(-3).reverse();
  main.append(h('p', { class: 'muted', style: 'margin-top:16px;font-size:var(--text-xs)' }, `Recent changes (${m.userChanges.length} yours + ${m.changes.length} from the build) · `, recent.length ? recent.map(c => `${c.field} ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)} ⟨${srcLabel(c.id)}⟩`).join(' · ') : 'no decisions yet', ' · ', h('a', { href: '#/log' }, 'Change log')));
}

function sortRows(rows, sort) {
  if (!sort) return rows; const [k, dir] = sort.split(':'); const s = dir === 'desc' ? -1 : 1;
  const key = r => k === 'amount' ? (r.cents ?? -Infinity) : k === 'date' ? (r.date || '') : k === 'src' ? r.id.split(':').map(Number) : (r[k] ?? '');
  return rows.slice().sort((a, b) => { const x = key(a), y = key(b); if (Array.isArray(x)) return s * ((x[0] - y[0]) || (x[1] - y[1])); return s * (x < y ? -1 : x > y ? 1 : 0); });
}
function thSort(label, k, p, cls, param = 'sort', dflt = 'date:asc') { const cur = p.get(param) || dflt; const [ck, cd] = cur.split(':'); const st = ck === k ? (cd === 'desc' ? 'descending' : 'ascending') : null;
  return h('th', { scope: 'col', class: cls, 'aria-sort': st }, h('button', { onclick: () => setParam(param, ck === k ? (cd === 'asc' ? k + ':desc' : k + ':asc') : k + ':asc') }, label)); }
function sortBy(rows, spec, keyOf) { if (!spec) return rows; const [k, dir] = spec.split(':'); const s = dir === 'desc' ? -1 : 1; return rows.slice().sort((a, b) => { const x = keyOf(a, k), y = keyOf(b, k); return s * (x < y ? -1 : x > y ? 1 : 0); }); }
function viewBills(main, m, p) {
  const showEx = p.get('excluded') === '1'; let rows = showEx ? m.records : m.bills;
  const q = (p.get('q') || '').toLowerCase(), cat = p.get('cat') || '', mon = p.get('month') || '', flag = p.get('flag') || '', reason = p.get('reason') || '';
  if (q) rows = rows.filter(r => (r.merchant + ' ' + r.invoice + ' ' + r.raw.join(' ')).toLowerCase().includes(q));
  if (cat) rows = rows.filter(r => r.category === cat); if (mon) rows = rows.filter(r => (r.date || '').startsWith(mon));
  if (flag === 'flagged') rows = rows.filter(r => r.reasons.length); if (flag === 'clean') rows = rows.filter(r => !r.reasons.length);
  if (reason) rows = rows.filter(r => r.reasons.some(x => reasonKey(x) === reason));
  rows = sortRows(rows, p.get('sort') || 'date:asc');
  const PAGE = 200, page = parseInt(p.get('page') || '0', 10), pages = Math.max(1, Math.ceil(rows.length / PAGE)), view = rows.slice(page * PAGE, page * PAGE + PAGE);
  const months = [...new Set(m.records.map(r => (r.date || '').slice(0, 7)).filter(Boolean))].sort();
  const sel = p.get('i');
  main.append(h('div', { class: 'page-head' }, h('h1', {}, 'Bills'), h('span', { class: 'muted' }, `Showing ${rows.length} ${showEx ? 'of all' : 'retained'} rows`), h('label', { class: 'check', style: 'margin-left:8px' }, h('input', { type: 'checkbox', checked: showEx, onchange: e => setParam('excluded', e.target.checked ? '1' : null) }), ` include excluded (${m.records.length - m.bills.length})`)));
  main.append(h('div', { class: 'toolbar' }, h('input', { type: 'search', placeholder: 'Search merchant, invoice, raw text…', value: p.get('q') || '', 'aria-label': 'Search', oninput: e => { clearTimeout(e.target._t); e.target._t = setTimeout(() => setParam('q', e.target.value), 250); } }),
    h('select', { 'aria-label': 'Category', onchange: e => setParam('cat', e.target.value) }, h('option', { value: '' }, 'Category: all'), [...CATEGORIES, 'Uncategorised'].map(c => h('option', { value: c, selected: c === cat }, c))),
    h('select', { 'aria-label': 'Month', onchange: e => setParam('month', e.target.value) }, h('option', { value: '' }, 'Month: all'), months.map(x => h('option', { value: x, selected: x === mon }, x))),
    h('select', { 'aria-label': 'Flag', onchange: e => setParam('flag', e.target.value) }, h('option', { value: '' }, 'Flag: any'), h('option', { value: 'flagged', selected: flag === 'flagged' }, 'flagged'), h('option', { value: 'clean', selected: flag === 'clean' }, 'not flagged')),
    h('select', { 'aria-label': 'Reason', onchange: e => setParam('reason', e.target.value) }, h('option', { value: '' }, 'Reason: any'), REASON_KEYS.map(([k, l]) => h('option', { value: k, selected: k === reason }, l))),
    h('button', { class: 'btn btn-ghost btn-sm', onclick: () => go('bills', { excluded: showEx ? '1' : null }) }, 'Clear filters'), h('span', { class: 'showing' }, `page ${page + 1}/${pages}`)));
  const tbl = h('table', { class: 'data' }, h('thead', {}, h('tr', {}, thSort('Src', 'src', p, 'sticky'), thSort('Invoice', 'invoice', p), thSort('Date', 'date', p), thSort('Merchant', 'merchant', p), thSort('Category', 'category', p), thSort('Amount (CAD)', 'amount', p, 'num'), h('th', { scope: 'col' }, 'Flags'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))),
    h('tbody', {}, view.length ? view.map(r => h('tr', { tabindex: '0', 'aria-selected': r.id === sel ? 'true' : null, dataset: { id: r.id }, onclick: () => setParam('i', r.id), onkeydown: e => { if (e.key === 'Enter') setParam('i', r.id); } },
      h('td', { class: 'sticky' }, srcChip(r.id, false)), h('td', { class: 'mono' }, r.invoice), h('td', { class: 'mono' + (r.date ? '' : ' faint') }, r.date || '— missing'), h('td', { title: r.raw[1] }, r.merchant), h('td', {}, h('span', { class: 'cat' }, r.category)), h('td', { class: 'num' + (r.cents === null ? ' faint' : '') }, money(r.cents)), h('td', {}, r.status !== 'clean' ? statusTag(r) : (r.reasons.length ? h('span', {}, tag('warning', 'Needs review'), ' ', reasonsList(r)) : (r.cents < 0 ? h('span', { class: 'reason' }, 'refund') : ''))), h('td', { class: 'actions' }, h('button', { class: 'btn btn-ghost btn-sm', onclick: e => { e.stopPropagation(); setParam('i', r.id); } }, 'Open'))))
      : h('tr', {}, h('td', { colspan: 8, class: 'empty-row' }, h('b', {}, 'No rows match'), ' — the search and filters above leave nothing to show. ', h('button', { class: 'btn btn-sm', onclick: () => go('bills') }, 'Clear filters')))));
  main.append(h('div', { class: 'tablewrap' }, tbl));
  if (pages > 1) main.append(h('div', { class: 'pager' }, h('button', { class: 'btn btn-sm', disabled: page === 0, onclick: () => setParam('page', page - 1) }, '← Prev'), h('span', {}, `${page + 1} / ${pages} · ${PAGE} rows per page`), h('button', { class: 'btn btn-sm', disabled: page >= pages - 1, onclick: () => setParam('page', page + 1) }, 'Next →')));
  return { queue: null, actions: true };
}

function viewReview(main, m, p) {
  const key = p.get('reason') || 'all', queue = filteredQueue(m, key), rc = reasonCounts(m), flagged = m.flagged.length, done = m.decidedCount;
  const sel = p.get('i') || (queue.find(r => !r.decided) || queue[0])?.id;
  main.append(h('div', { class: 'page-head' }, h('h1', {}, 'Needs review'), h('span', { class: 'muted mono' }, `${done} of ${flagged} decided`), h('div', { class: 'progress', 'aria-hidden': 'true' }, h('i', { style: `transform:scaleX(${flagged ? done / flagged : 0})` })), h('span', { class: 'muted mono' }, `${flagged - done} left`),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: S.ui.autoAdvance, onchange: e => { S.ui.autoAdvance = e.target.checked; persist(); } }), ' auto-advance'),
    h('select', { 'aria-label': 'Sort', onchange: e => { S.ui.sort = e.target.value; persist(); render(); } }, h('option', { value: 'source', selected: S.ui.sort === 'source' }, 'Sort: source order'), h('option', { value: 'amount', selected: S.ui.sort === 'amount' }, 'Sort: amount ↓')),
    h('button', { class: 'btn', onclick: () => { S.ui.suggestOpen = !S.ui.suggestOpen; render(); } }, 'Suggestions ▾')));
  if (S.ui.suggestOpen) main.append(suggestPanel(m));
  main.append(h('div', { class: 'filters', role: 'group', 'aria-label': 'Filter by reason' }, [['all', 'all', flagged], ...Object.entries(rc).sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, reasonLabel(k), n]), ['decided', 'decided', done]].map(([k, l, n]) => h('button', { 'aria-pressed': key === k ? 'true' : 'false', onclick: () => go('review', { reason: k === 'all' ? null : k }) }, `${l} ${n}`))));
  if (!queue.length) main.append(h('div', { class: 'empty' }, h('h2', {}, flagged && done === flagged ? 'Nothing left to review' : 'No rows match this filter'), h('p', {}, flagged && done === flagged ? `All ${flagged} flagged rows have a decision.` : 'Pick another reason, or change a rule to re-flag rows.'), h('div', { class: 'toolbar' }, h('a', { class: 'btn btn-primary', href: '#/export' }, 'Export workbook'), h('a', { class: 'btn', href: '#/rules' }, 'Change a rule'))));
  else main.append(h('ol', { class: 'queue', role: 'listbox', 'aria-label': 'Review queue', id: 'queue' }, queue.map(r => h('li', { role: 'option', tabindex: r.id === sel ? '0' : '-1', 'aria-selected': r.id === sel ? 'true' : 'false', class: r.decided ? 'decided' : '', dataset: { id: r.id }, onclick: () => setParam('i', r.id), onkeydown: e => { if (e.key === 'Enter') { setParam('i', r.id); focusInspector(); } } },
    srcChip(r.id, false), h('span', { class: 'who' }, r.merchant, ' ', h('small', { class: 'mono' }, r.invoice)), r.decided ? h('span', { class: 'amt undo-wrap' }, tag('success', 'decided · ' + r.decided), ' ', h('button', { class: 'btn btn-ghost btn-sm', onclick: e => { e.stopPropagation(); const d = S.decisions.filter(x => x.rowId === r.id && !x.undoneBy && x.action !== 'undo').pop(); if (d) { undoDecision(d.id); toast('Decision undone'); render(); } } }, 'undo')) : h('span', { class: 'amt' }, money(r.cents)), reasonsList(r)))));
  return { queue, selected: sel, actions: true };
}
function focusInspector() { const t = $('#insp-title'); if (t) t.focus(); }
function suggestPanel(m) {
  const unmapped = m.records.filter(r => r.reasons.includes('unmapped merchant') && !r.decided);
  const mode = S.ui.suggestMode || 'sim';
  const L = S.llm;   // { provider, model, baseUrl } — settings only; the key lives in S.apiKey (memory, never persisted)
  if (S.cache === undefined) { S.cache = null; fetch('llm-cache.json', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).then(j => { S.cache = j && j.entries ? j : null; if (S.ui.suggestOpen) render(); }).catch(() => { S.cache = null; }); }
  const cachedHits = S.cache ? unmapped.filter(r => S.cache.entries[r.merchant.toLowerCase().replace(/[^a-z0-9]/g, '')]) : [];
  const cacheLabel = S.cache ? `${S.cache.provider ? LLM.LABEL[S.cache.provider] + ' · ' : ''}${S.cache.model}` : '';
  const providerSel = h('select', { 'aria-label': 'Model provider', onchange: e => { L.provider = e.target.value; L.model = LLM.DEFAULT_MODEL[L.provider] || ''; L.baseUrl = ''; render(); } },
    LLM.PROVIDERS.map(p => h('option', { value: p, selected: p === L.provider }, LLM.LABEL[p])));
  const modelIn = h('input', { type: 'text', 'aria-label': 'Model id', value: L.model, placeholder: 'model id from your provider’s list', autocomplete: 'off', spellcheck: 'false', style: 'width:14em', oninput: e => { L.model = e.target.value; } });
  const baseIn = h('input', { type: 'url', 'aria-label': 'Endpoint base URL', value: L.baseUrl, placeholder: 'http://localhost:11434/v1', autocomplete: 'off', style: 'width:16em', oninput: e => { L.baseUrl = e.target.value; } });
  const keyIn = h('input', { type: 'password', 'aria-label': 'API key', value: S.apiKey || '', placeholder: L.provider === 'openai-compatible' ? 'API key (if the endpoint needs one)' : 'API key', autocomplete: 'off', style: 'width:14em' });
  const hints = {
    anthropic: 'Sent straight from this tab to Anthropic, with the browser-access header Anthropic requires for direct calls.',
    openai: 'Sent straight from this tab to OpenAI.',
    gemini: 'Sent straight from this tab to Google; the key goes in a header, never in the URL.',
    'openai-compatible': 'Ollama, LM Studio, vLLM or a gateway. The server must allow this page’s origin (Ollama: set OLLAMA_ORIGINS).',
  };
  const status = h('span', { class: 'muted', style: 'font-size:var(--text-xs)' }, S.suggestMeta ? `last run: ${S.suggestMeta.mode === 'model' ? S.suggestMeta.model : 'simulated (canned keyword rules)'} · ${S.suggestMeta.n} rows · ${hhmm(S.suggestMeta.at)}${S.suggestMeta.error ? ' · ' + S.suggestMeta.error : ''}` : 'nothing run yet');
  const run = async () => {
    if (!unmapped.length) return toast('No undecided unmapped rows');
    if (mode === 'sim') { for (const r of unmapped) S.suggestions[r.id] = simulatedSuggestion(r); S.suggestMeta = { mode: 'sim', n: unmapped.length, at: nowIso() }; render(); toast(`Simulated suggestions for ${unmapped.length} rows (no network)`); return; }
    if (mode === 'cached') { for (const r of unmapped) { const e = S.cache.entries[r.merchant.toLowerCase().replace(/[^a-z0-9]/g, '')]; S.suggestions[r.id] = e ? { category: e.category, reason: e.reason || '', mode: 'model', model: `${cacheLabel} · cached ${S.cache.generated}` } : { category: null, reason: 'no cached model output for this merchant', mode: 'model', model: cacheLabel }; } S.suggestMeta = { mode: 'model', model: `${cacheLabel} (cached ${S.cache.generated})`, n: unmapped.length, at: nowIso() }; render(); toast(`Applied cached model output (${cacheLabel}, ${S.cache.generated}) to ${cachedHits.length} of ${unmapped.length} rows`); return; }
    let cfg;
    try { cfg = LLM.config({ provider: L.provider, model: modelIn.value, baseUrl: baseIn.value, apiKey: keyIn.value }); }
    catch (e) { return toast(e.message, { kind: 'error' }); }
    S.apiKey = cfg.apiKey || null; L.model = cfg.model; const who = LLM.describe(cfg); status.textContent = `asking ${who}…`;
    try { const out = await askModel(cfg, unmapped); for (const r of unmapped) S.suggestions[r.id] = out.rows[r.id] || { category: null, reason: 'no answer for this row', mode: 'model', model: out.who }; S.suggestMeta = { mode: 'model', model: out.who, n: unmapped.length, at: nowIso() }; render(); toast(`${out.who} suggested categories for ${Object.keys(out.rows).length} of ${unmapped.length} rows`); }
    catch (e) { S.suggestMeta = { mode: 'model', model: who, n: 0, at: nowIso(), error: e.message }; render(); toast('Model request failed: ' + e.message + ' — nothing was changed', { kind: 'error', ms: 9000 }); }
  };
  return h('div', { class: 'card', style: 'margin-bottom:12px' }, h('h2', {}, `Suggestions for ${plural(unmapped.length, 'unmapped row')}`),
    h('div', { class: 'stack', style: 'gap:8px' },
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'sm', checked: mode === 'sim', onchange: () => { S.ui.suggestMode = 'sim'; render(); } }), ' Simulate suggestions — canned keyword rules, no network, labelled "simulated"'),
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'sm', checked: mode === 'cached', disabled: !S.cache, onchange: () => { S.ui.suggestMode = 'cached'; render(); } }), S.cache ? ` Use cached model output from the repo — ${cacheLabel} · ${S.cache.generated} · covers ${cachedHits.length} of ${unmapped.length} rows` : ' Cached model output — not available (no llm-cache.json served, or offline)'),
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'sm', checked: mode === 'model', onchange: () => { S.ui.suggestMode = 'model'; render(); } }), ' Use my own model — Claude, OpenAI, Gemini or any OpenAI-compatible endpoint; the key stays in this tab’s memory, never stored'),
      mode === 'model' ? h('div', { class: 'stack', style: 'gap:6px' },
        h('div', { class: 'rule-edit' }, providerSel, modelIn, L.provider === 'openai-compatible' ? baseIn : null),
        h('div', { class: 'rule-edit' }, keyIn, h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { S.apiKey = null; keyIn.value = ''; toast('Key forgotten'); } }, 'Forget key'), navigator.onLine ? null : h('span', { class: 'muted' }, 'offline — API calls will fail')),
        h('p', { class: 'hint' }, hints[L.provider])) : null,
      h('div', { class: 'rule-edit' }, h('button', { class: 'btn btn-primary btn-sm', onclick: run }, mode === 'sim' ? `Simulate on ${unmapped.length} rows` : mode === 'cached' ? `Apply cached output to ${unmapped.length} rows` : `Ask ${LLM.LABEL[L.provider]} about ${unmapped.length} rows`), status),
      h('p', { class: 'hint' }, 'Results appear on each row as a suggestion with Accept / Dismiss. Nothing is applied automatically; accepting is recorded as a decision you made.')));
}
const KEYWORDS = [[/supply|supplies|office|paper|stationer/i, 'Supplies'], [/utility|hydro|electric|water|gas|power|energy|telecom|fibre|fiber|internet/i, 'Utilities'], [/software|saas|cloud|app|hosting|licen/i, 'Software'], [/lease|rent|landlord|property|realty/i, 'Rent'], [/carrier|freight|courier|shipping|transport|logistic|delivery|haul/i, 'Transport']];
function simulatedSuggestion(r) { const hit = KEYWORDS.find(([rx]) => rx.test(r.merchant)); return hit ? { category: hit[1], reason: `name matches keyword ${hit[0].source.split('|')[0].replace(/\\/g, '')}`, mode: 'sim' } : { category: null, reason: 'no keyword match — a simulated rule cannot guess this name', mode: 'sim' }; }
async function askModel(cfg, rows) {
  const items = rows.map(r => ({ id: r.id, merchant: r.merchant, raw: r.raw[1], amount_cad: r.cents === null ? null : r.cents / 100 }));
  const system = `You classify small-business bill merchants into exactly one of these categories: ${CATEGORIES.join(', ')}. If the name gives no reliable signal, use null. Reply with JSON only: an array of {"id": string, "category": string|null, "confidence": number 0-1, "reason": short string}. Never invent facts about the merchant.`;
  const res = await LLM.complete(cfg, system, JSON.stringify(items), { maxTokens: 2048 });
  const who = `${LLM.LABEL[cfg.provider]} · ${res.model}`;
  const rowsOut = {};
  for (const x of LLM.extractJson(res.text, 'array')) { if (!x || typeof x.id !== 'string') continue; const cat = CATEGORIES.includes(x.category) ? x.category : null; rowsOut[x.id] = { category: cat, confidence: typeof x.confidence === 'number' ? x.confidence : null, reason: (cat ? '' : 'category not in the allowed list or null · ') + String(x.reason || '').slice(0, 140), mode: 'model', model: who }; }
  return { rows: rowsOut, who };
}

function viewDuplicates(main, m) {
  main.append(h('div', { class: 'page-head' }, h('h1', {}, 'Duplicates')));
  const pair = (a, b, label, note, acts) => h('div', { class: 'card', style: 'margin-bottom:8px' }, h('div', { class: 'grid-2' }, [['retained', a], [label, b]].map(([t, r]) => h('div', {}, h('div', { class: 'faint', style: 'font-size:var(--text-2xs);text-transform:uppercase;letter-spacing:.04em' }, t), r ? h('div', { style: 'margin-top:4px' }, srcChip(r.id), ' ', h('span', { class: 'mono' }, r.invoice), ' · ', h('span', { class: 'mono' }, r.date || '—'), ' · ', r.merchant, ' · ', h('span', { class: 'mono' }, money(r.cents))) : h('div', { class: 'muted' }, '(source row not found)')))), h('p', { class: 'hint', style: 'margin-top:8px' }, note), acts ? h('div', { class: 'toolbar', style: 'margin-top:8px' }, acts) : null);
  main.append(h('h2', { style: 'font-size:var(--text-md);margin:8px 0' }, `Exact duplicates · ${m.dups.length} · excluded once, amount kept in reconciliation`));
  if (!m.dups.length) main.append(h('div', { class: 'empty' }, h('h3', {}, 'No exact duplicates'), h('p', {}, 'No two rows share invoice, merchant, date and cents, so nothing was excluded.'), h('a', { class: 'btn', href: '#/bills' }, 'Open Bills')));
  for (const d of m.dups) main.append(pair(m.byId[d.duplicate_of], d, 'duplicate', d.decided === 'duplicate' ? 'Marked by you. Undo from the inspector.' : 'All four keys match: invoice · merchant · date · cents.', h('button', { class: 'btn btn-sm', onclick: () => { setParam('i', d.id); } }, 'Open')));
  main.append(h('h2', { style: 'font-size:var(--text-md);margin:16px 0 8px' }, `Possible duplicates · ${m.possible.length} · retained in Bills, pending review`));
  if (!m.possible.length) main.append(h('div', { class: 'empty' }, h('h3', {}, 'No possible duplicates'), h('p', {}, 'No retained rows share merchant, date and cents with a different invoice id.'), h('a', { class: 'btn', href: '#/review' }, 'Open the review queue')));
  for (const c of m.possible) { const orig = m.byId[(/possible duplicate of ([^;]+)/.exec(c.reasons.join(';')) || [])[1]]; main.append(pair(orig, c, 'candidate', 'Same merchant, date and cents; differs: invoice id. A human decides whether it is a second bill.', !c.decided ? [h('button', { class: 'btn btn-sm', onclick: () => { const d = decide(c.id, 'confirm', {}); toast('Kept both (second bill)', { undo: () => { undoDecision(d.id); render(); } }); render(); } }, 'Keep both (second bill)'), orig ? h('button', { class: 'btn btn-sm', onclick: () => { const d = decide(c.id, 'duplicate', { before: c.status, after: orig.id }); toast(`Marked ${srcLabel(c.id)} as duplicate of ${srcLabel(orig.id)}`, { undo: () => { undoDecision(d.id); render(); } }); render(); } }, `Mark ${srcLabel(c.id)} as duplicate of ${srcLabel(orig.id)}`) : null] : h('span', { class: 'muted' }, 'decided · ' + c.decided))); }
}

function viewRules(main, m) {
  const pend = S.pending || { aliases: S.rules.aliases.map(r => ({ ...r })), threshold: S.rules.threshold, dirty: false };
  const build = E.MERCHANTS.map(([alias, category]) => ({ alias, category, who: 'build' }));
  const matched = alias => m.records.filter(r => r.merchant === alias).length;
  main.append(h('div', { class: 'page-head' }, h('h1', {}, 'Rules & thresholds'), h('span', { class: 'spacer' }), h('button', { class: 'btn btn-sm', onclick: importRules }, 'Import rules JSON'), h('button', { class: 'btn btn-sm', onclick: () => download('rules.json', JSON.stringify({ aliases: S.rules.aliases.map(({ alias, category }) => ({ alias, category })), high_cad: S.rules.threshold / 100 }, null, 2), 'application/json') }, 'Export rules JSON')));
  const rows = [];
  for (const b of build) { const ov = pend.aliases.find(x => x.alias === b.alias); rows.push({ ...b, effective: ov ? ov.category : b.category, overridden: !!ov }); }
  for (const u of pend.aliases.filter(x => !build.some(b => b.alias === x.alias))) rows.push({ ...u, effective: u.category, who: 'you' });
  const edit = (row) => { const sel = h('select', { 'aria-label': `Category for ${row.alias}` }, [...CATEGORIES, 'Uncategorised'].map(c => h('option', { value: c, selected: c === row.effective }, c))); return h('span', { class: 'rule-edit' }, sel, h('button', { class: 'btn btn-sm', onclick: () => { const cat = sel.value; const np = { ...pend, aliases: pend.aliases.filter(x => x.alias !== row.alias), dirty: true }; if (!(row.who === 'build' && cat === row.category)) np.aliases.push({ id: uid(), alias: row.alias, category: cat, who: 'you', at: nowIso() }); S.pending = np; render(); } }, 'Set')); };
  const rp = route().p; const sorted = sortBy(rows, rp.get('sort') || '', (r, k) => k === 'matched' ? matched(r.alias) : String(r[k === 'category' ? 'effective' : k] ?? ''));
  const tbl = h('table', { class: 'data' }, h('thead', {}, h('tr', {}, thSort('Alias', 'alias', rp, null, 'sort', ''), thSort('Category', 'category', rp, null, 'sort', ''), thSort('Rows matched', 'matched', rp, 'num', 'sort', ''), thSort('Added by', 'who', rp, null, 'sort', ''), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))),
    h('tbody', {}, sorted.map(r => h('tr', { style: 'cursor:default' }, h('td', {}, r.alias), h('td', {}, h('span', { class: 'cat' }, r.effective), r.effective === 'Uncategorised' ? h('span', { class: 'reason', style: 'margin-left:6px' }, 'flagged') : null, r.overridden ? h('span', { class: 'chip', style: 'margin-left:6px' }, 'overridden') : null), h('td', { class: 'num' }, matched(r.alias)), h('td', {}, r.who), h('td', { class: 'actions' }, edit(r))))));
  const newAlias = h('input', { type: 'text', placeholder: 'merchant name as it appears after normalisation', style: 'min-width:260px', 'aria-label': 'New merchant alias' }), newCat = h('select', { 'aria-label': 'Category for the new alias' }, CATEGORIES.map(c => h('option', { value: c }, c)));
  main.append(h('div', { class: 'card' }, h('h2', {}, 'Merchant alias → category (exact match after normalisation)'), h('div', { class: 'tablewrap' }, tbl), h('div', { class: 'rule-edit', style: 'margin-top:12px' }, newAlias, newCat, h('button', { class: 'btn btn-sm', onclick: () => { const a = newAlias.value.trim(); if (!a) return; S.pending = { ...pend, aliases: pend.aliases.filter(x => x.alias !== a).concat([{ id: uid(), alias: a, category: newCat.value, who: 'you', at: nowIso() }]), dirty: true }; render(); } }, '+ Add alias'))));
  const thr = h('input', { type: 'text', inputmode: 'decimal', value: E.thresholdLabel(pend.threshold), style: 'width:8em', 'aria-label': 'High-amount threshold in CAD' });
  main.append(h('div', { class: 'grid-2', style: 'margin-top:16px' },
    h('div', { class: 'card' }, h('h2', {}, 'High-amount threshold'), h('div', { class: 'rule-edit' }, 'Flag |amount| ≥ CAD ', thr, h('button', { class: 'btn btn-sm', onclick: () => { const v = thr.value.replace(/,/g, ''); if (!/^\d+(\.\d{1,2})?$/.test(v)) return toast('Enter a CAD amount with at most two decimals', { kind: 'error' }); S.pending = { ...pend, threshold: Math.round(parseFloat(v) * 100), dirty: true }; render(); } }, 'Set')), h('p', { class: 'hint', style: 'margin-top:8px' }, `currently flags ${m.records.filter(r => r.cents !== null && Math.abs(r.cents) >= S.rules.threshold).length} rows · recorded in the ledger and shown in the workbook's high-bill heading`)),
    h('div', { class: 'card' }, h('h2', {}, 'Date policy (read-only in v1)'), h('p', { class: 'hint' }, 'Accepts 2025-02-01, 2025/02/01 and 08-Mar-2025. Rejects 03/04/2025 because the source does not define a day/month order. Explained, not editable.'))));
  if (pend.dirty) {
    const preview = buildModel({ aliases: pend.aliases, threshold: pend.threshold }, S.decisions);
    const recat = preview.records.filter((r, i) => r.category !== m.records[i].category).length, flaggedNow = m.records.filter(r => r.reasons.length).length, flaggedThen = preview.records.filter(r => r.reasons.length).length, logDelta = preview.changes.length - m.changes.length;
    main.append(h('div', { class: 'pending', role: 'status' }, h('b', {}, 'Pending changes'), h('p', {}, `This will re-categorise ${plural(recat, 'row')}, ${flaggedThen < flaggedNow ? 'un-flag ' + (flaggedNow - flaggedThen) : 'flag ' + (flaggedThen - flaggedNow)} and ${logDelta >= 0 ? 'add' : 'remove'} ${plural(Math.abs(logDelta), 'change-log entry').replace('entrys', 'entries')}. Decisions already made stay.`),
      h('div', { class: 'toolbar' }, h('button', { class: 'btn btn-primary', onclick: () => { S.rules = { aliases: pend.aliases, threshold: pend.threshold }; S.pending = null; invalidate(); persist(); render(); toast('Rules applied'); } }, 'Apply changes'), h('button', { class: 'btn', onclick: () => { S.pending = null; render(); } }, 'Discard'))));
  }
}
function importRules() { const input = h('input', { type: 'file', accept: '.json', onchange: async e => { try { const j = JSON.parse(await e.target.files[0].text()); const aliases = (j.aliases || []).filter(x => x.alias && [...CATEGORIES, 'Uncategorised'].includes(x.category)).map(x => ({ id: uid(), alias: String(x.alias), category: x.category, who: 'you', at: nowIso() })); S.pending = { aliases, threshold: j.high_cad ? Math.round(j.high_cad * 100) : S.rules.threshold, dirty: true }; render(); toast(`Imported ${aliases.length} rules — review the pending changes`); } catch (err) { toast('Could not read rules JSON: ' + err.message, { kind: 'error' }); } } }); input.click(); }

function svgBars(data, { height = 180, unknownKeys = [] } = {}) { // vertical bars, one hue; labels below; values on top
  const W = 600, pad = 28, n = data.length, bw = (W - pad * 2) / n, max = Math.max(1, ...data.map(d => Math.abs(d.v)));
  const y = v => height - 30 - Math.abs(v) / max * (height - 60);
  return h('svg', { viewBox: `0 0 ${W} ${height}`, role: 'img', 'aria-label': data.map(d => `${d.k}: ${d.label}`).join(', ') }, h('defs', { html: '<pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="var(--viz-axis)"/></pattern>' }),
    [0.25, 0.5, 0.75, 1].map(f => h('line', { class: 'grid', x1: pad, x2: W - pad, y1: y(max * f), y2: y(max * f) })), h('line', { class: 'axis', x1: pad, x2: W - pad, y1: height - 30, y2: height - 30 }),
    data.map((d, i) => [h('rect', { class: 'bar' + (unknownKeys.includes(d.k) ? ' unknown' : ''), x: pad + i * bw + bw * 0.15, width: bw * 0.7, y: y(d.v), height: Math.max(1, height - 30 - y(d.v)) }, h('title', {}, `${d.k}: ${d.label}`)), h('text', { x: pad + i * bw + bw / 2, y: height - 14, 'text-anchor': 'middle' }, d.k.length > 8 ? d.k.slice(0, 7) + '…' : d.k), n <= 12 ? h('text', { x: pad + i * bw + bw / 2, y: y(d.v) - 4, 'text-anchor': 'middle', style: 'font-size:9px' }, d.short) : null]));
}
function chartCard(title, note, data, tableCols, key, opts) {
  const mode = (S.ui.chartMode || {})[key] || 'chart';
  const seg = h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'View as' }, ['chart', 'table'].map(x => h('button', { role: 'radio', 'aria-checked': mode === x ? 'true' : 'false', onclick: () => { S.ui.chartMode = { ...(S.ui.chartMode || {}), [key]: x }; render(); } }, x[0].toUpperCase() + x.slice(1))));
  const body = mode === 'chart' ? svgBars(data, opts) : h('div', { class: 'tablewrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, tableCols.map(c => h('th', {}, c)))), h('tbody', {}, data.map(d => h('tr', { style: 'cursor:default' }, h('td', {}, d.k), h('td', { class: 'num' }, d.label), h('td', { class: 'num' }, d.n))))));
  return h('div', { class: 'chart' }, h('div', { class: 'ch-head' }, h('h2', {}, title), seg, h('p', {}, note)), body);
}
function viewDashboard(main, m) {
  const bills = m.bills.filter(r => r.cents !== null), tot = bills.reduce((a, r) => a + r.cents, 0);
  main.append(h('div', { class: 'page-head' }, h('h1', {}, 'Dashboard'), h('span', { class: 'sub' }, `Totals use retained rows with known amounts (${bills.length} rows, CAD ${money(tot)}). Duplicates, unparseable and excluded rows are left out; reviewer category changes are included.`)));
  const months = [...new Set(bills.map(r => r.date.slice(0, 7)))].sort();
  const monthly = months.map(mo => { const rs = bills.filter(r => r.date.startsWith(mo)); const v = rs.reduce((a, r) => a + r.cents, 0); return { k: mo, v, label: money(v), short: E.moneyStr(Math.round(v / 100) * 100, true).replace(/\.00$/, ''), n: rs.length }; });
  const cats = [...new Set(bills.map(r => r.category))].sort().map(c => { const rs = bills.filter(r => r.category === c); const v = rs.reduce((a, r) => a + r.cents, 0); return { k: c, v, label: money(v), short: E.moneyStr(Math.round(v / 100) * 100, true).replace(/\.00$/, ''), n: rs.length }; });
  const merch = {}; for (const r of bills) merch[r.merchant] = merch[r.merchant] || { n: 0, v: 0 }, merch[r.merchant].n++, merch[r.merchant].v += r.cents;
  const p = route().p;
  const top = sortBy(Object.entries(merch), p.get('msort') || 'total:desc', ([k, x], key) => key === 'merchant' ? k : key === 'rows' ? x.n : key === 'total' ? x.v : x.v / tot);
  const high = sortBy(m.bills.filter(r => r.cents !== null && Math.abs(r.cents) >= S.rules.threshold), p.get('hsort') || 'amount:desc', (r, key) => key === 'amount' ? Math.abs(r.cents) : key === 'src' ? r.id.split(':').map(Number).reduce((a, b) => a * 10000 + b, 0) : String(r[key] ?? ''));
  main.append(h('div', { class: 'grid-2' }, chartCard('Monthly totals', 'Retained bills by invoice month, CAD. One hue: months are categories, not a scale.', monthly, ['Month', 'Total CAD', 'Rows'], 'monthly'), chartCard('Category totals', 'Uncategorised rows are hatched: their category is not known yet.', cats, ['Category', 'Total CAD', 'Rows'], 'cats', { unknownKeys: ['Uncategorised'] })));
  main.append(h('div', { class: 'grid-2', style: 'margin-top:16px' },
    h('div', { class: 'card' }, h('h2', {}, 'Top merchants'), h('div', { class: 'tablewrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, thSort('Merchant', 'merchant', p, null, 'msort', 'total:desc'), thSort('Rows', 'rows', p, 'num', 'msort', 'total:desc'), thSort('Total CAD', 'total', p, 'num', 'msort', 'total:desc'), thSort('Share', 'share', p, 'num', 'msort', 'total:desc'))), h('tbody', {}, top.map(([k, x]) => h('tr', { style: 'cursor:default' }, h('td', {}, k), h('td', { class: 'num' }, x.n), h('td', { class: 'num' }, money(x.v)), h('td', { class: 'num' }, (x.v / tot * 100).toFixed(1) + '%'))))))),
    h('div', { class: 'card' }, h('h2', {}, `High bills ≥ CAD ${E.thresholdLabel(S.rules.threshold)} (${high.length})`), h('p', { class: 'hint' }, 'Includes large refunds (absolute amount).'), h('div', { class: 'tablewrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, thSort('Src', 'src', p, null, 'hsort', 'amount:desc'), thSort('Invoice', 'invoice', p, null, 'hsort', 'amount:desc'), thSort('Merchant', 'merchant', p, null, 'hsort', 'amount:desc'), thSort('Amount', 'amount', p, 'num', 'hsort', 'amount:desc'))), h('tbody', {}, high.map(r => h('tr', { onclick: () => go('bills', { i: r.id }) }, h('td', {}, srcChip(r.id, false)), h('td', { class: 'mono' }, r.invoice), h('td', {}, r.merchant), h('td', { class: 'num' }, money(r.cents))))))))));
}

function viewLog(main, m, p) {
  const who = p.get('who') || 'all', field = p.get('field') || '', rule = p.get('rule') || '', sheet = p.get('sheet') || '';
  let all = m.changes.map(c => ({ ...c, who: c.who || 'build', at: null })).concat(m.userChanges.map(c => ({ ...c, source_sheet: m.byId[c.id]?.source_sheet })));
  all = all.map((c, i) => ({ ...c, n: i + 1 }));
  let rows = all; if (who !== 'all') rows = rows.filter(c => c.who === who); if (field) rows = rows.filter(c => c.field === field); if (rule) rows = rows.filter(c => c.rule === rule); if (sheet) rows = rows.filter(c => c.source_sheet === sheet);
  const uniq = k => [...new Set(all.map(c => c[k]).filter(Boolean))].sort();
  main.append(h('div', { class: 'page-head' }, h('h1', {}, 'Change log'), h('span', { class: 'muted' }, `${all.length} entries (${m.changes.length} build + ${m.userChanges.length} yours)`), h('span', { class: 'spacer' }), h('button', { class: 'btn btn-sm', onclick: () => download('change-log.csv', '﻿' + ['n,src,field,before,after,rule,who,when'].concat(rows.map(c => [c.n, srcLabel(c.id), c.field, c.before, c.after, c.rule, c.who, c.at || ''].map(x => '"' + String(x ?? '').replace(/"/g, '""') + '"').join(','))).join('\n'), 'text/csv') }, 'Export CSV')));
  main.append(h('div', { class: 'toolbar' }, h('select', { 'aria-label': 'Field', onchange: e => setParam('field', e.target.value) }, h('option', { value: '' }, 'Field: all'), uniq('field').map(x => h('option', { value: x, selected: x === field }, x))), h('select', { 'aria-label': 'Rule', onchange: e => setParam('rule', e.target.value) }, h('option', { value: '' }, 'Rule: all'), uniq('rule').map(x => h('option', { value: x, selected: x === rule }, x))), h('select', { 'aria-label': 'Sheet', onchange: e => setParam('sheet', e.target.value) }, h('option', { value: '' }, 'Sheet: all'), uniq('source_sheet').map(x => h('option', { value: x, selected: x === sheet }, x))),
    h('div', { class: 'filters', style: 'margin:0' }, ['all', 'build', 'you'].map(w => h('button', { 'aria-pressed': who === w ? 'true' : 'false', onclick: () => setParam('who', w === 'all' ? null : w) }, w))), h('span', { class: 'showing' }, `showing ${rows.length}`)));
  rows = sortBy(rows, p.get('sort') || 'n:asc', (c, k) => k === 'n' ? c.n : k === 'src' ? c.id.split(':').map(Number).reduce((a, b) => a * 10000 + b, 0) : String(c[k] ?? ''));
  const PAGE = 200, page = parseInt(p.get('page') || '0', 10), pages = Math.max(1, Math.ceil(rows.length / PAGE)), view = rows.slice(page * PAGE, (page + 1) * PAGE);
  main.append(h('div', { class: 'tablewrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, thSort('#', 'n', p, 'num', 'sort', 'n:asc'), thSort('Src', 'src', p, null, 'sort', 'n:asc'), thSort('Field', 'field', p, null, 'sort', 'n:asc'), h('th', { scope: 'col' }, 'Before → after'), thSort('Rule', 'rule', p, null, 'sort', 'n:asc'), thSort('Who', 'who', p, null, 'sort', 'n:asc'), thSort('When', 'at', p, null, 'sort', 'n:asc'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))),
    h('tbody', {}, view.map(c => h('tr', { onclick: () => go('bills', { i: c.id, excluded: '1' }) }, h('td', { class: 'num' }, c.n), h('td', {}, srcChip(c.id, false)), h('td', {}, c.field), h('td', { class: 'mono', title: JSON.stringify(c.before) + ' → ' + JSON.stringify(c.after) }, JSON.stringify(c.before), ' → ', h('b', {}, JSON.stringify(c.after))), h('td', {}, c.rule), h('td', {}, c.who), h('td', { class: 'mono' }, c.at ? hhmm(c.at) : '—'), h('td', { class: 'actions' }, c.who === 'you' && c.did && !c.rule.startsWith('reviewer undo') && !S.decisions.find(d => d.id === c.did)?.undoneBy ? h('button', { class: 'btn btn-ghost btn-sm', onclick: e => { e.stopPropagation(); undoDecision(c.did); toast('Decision undone'); render(); } }, 'undo') : null)))))));
  if (pages > 1) main.append(h('div', { class: 'pager' }, h('button', { class: 'btn btn-sm', disabled: page === 0, onclick: () => setParam('page', page - 1) }, '← Prev'), h('span', {}, `${page + 1} / ${pages}`), h('button', { class: 'btn btn-sm', disabled: page >= pages - 1, onclick: () => setParam('page', page + 1) }, 'Next →')));
}

function viewExport(main, m) {
  const checks = S.checks || runChecks(), bad = checks.items.filter(c => !c.ok).length, rec = m.reconciliation, flagged = m.records.filter(r => r.reasons.length).length;
  const stamp = new Date().toISOString().slice(0, 10), base = S.source.kind === 'sample' ? `seed${S.source.seed}` : (S.source.name || 'file').replace(/\.[^.]+$/, '');
  main.append(h('div', { class: 'page-head' }, h('h1', {}, 'Export')));
  main.append(h('div', { class: 'grid-2' },
    h('div', { class: 'card' }, h('h2', {}, 'Workbook · cleaned-bills.xlsx'), h('p', { class: 'hint' }, `Summary · Bills ${m.bills.length} · Needs review ${flagged} (${m.decidedCount} decided) · Duplicates ${m.dups.length} · Change log ${m.changes.length + m.userChanges.length}`), h('p', { class: 'hint', style: 'margin-top:4px' }, 'Deterministic: same input + same decisions → same bytes. Built here with the same OOXML writer the CLI uses, from the bundled templates.'),
      h('div', { class: 'toolbar', style: 'margin-top:12px' }, h('button', { class: 'btn btn-primary', onclick: async e => { e.target.textContent = 'Building…'; download(`cleaned-bills-${base}-${stamp}.xlsx`, await exportWorkbook(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); e.target.textContent = 'Download workbook'; } }, 'Download workbook'), bad ? h('span', { class: 'muted', style: 'color:var(--danger)' }, `${bad} check failed — see Overview`) : null)),
    h('div', { class: 'card' }, h('h2', {}, 'Checks before you download'), h('ul', { class: 'checks' }, checks.items.map(c => h('li', { class: c.ok ? 'ok' : 'bad', title: c.detail }, h('span', {}, c.name, ' ', h('span', { class: 'faint' }, '· ' + c.detail)))), h('li', { class: 'na' }, h('span', {}, 'Byte-identical to the Python build: not verified here. Download the three files into one folder and run ', h('code', {}, 'python3 -B demo.py check --out <folder> --no-repeat'), ' locally', S.decisions.length || S.rules.aliases.length ? ' — only exports with zero decisions and no reviewer rules can pass the CLI checker.' : '.'))), h('div', { class: 'toolbar', style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: () => { runChecks(); render(); } }, `Re-run (${hhmm(checks.at)})`)))));
  main.append(h('div', { class: 'grid-2', style: 'margin-top:16px' },
    h('div', { class: 'card' }, h('h2', {}, 'ledger.json'), h('p', { class: 'hint' }, 'Every row, every change, every decision and rule. Zero-decision exports are byte-identical to the CLI\'s ledger.'), h('div', { class: 'toolbar', style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: () => download(`ledger-${base}-${stamp}.json`, exportLedger(), 'application/json') }, 'Download ledger.json'), S.source.kind === 'sample' ? h('button', { class: 'btn', onclick: async () => download(`dirty-input-${base}.xlsx`, await exportInput(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') }, 'Download input workbook') : null)),
    h('div', { class: 'card' }, h('h2', {}, 'rules.json'), h('p', { class: 'hint' }, `${S.rules.aliases.length} reviewer rules · threshold CAD ${E.thresholdLabel(S.rules.threshold)}`), h('div', { class: 'toolbar', style: 'margin-top:12px' }, h('button', { class: 'btn', onclick: () => download('rules.json', JSON.stringify({ aliases: S.rules.aliases.map(({ alias, category }) => ({ alias, category })), high_cad: S.rules.threshold / 100 }, null, 2), 'application/json') }, 'Download rules.json')))));
}

/* ---------- nav / render / keyboard / init ---------- */
const ICONS = { '': 'M8 2v8m-3-3 3 3 3-3M3 12v2h10v-2', overview: 'M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3zm0 3v2l1.5 1.5', bills: 'M3 4h10M3 8h10M3 12h7', review: 'M3 3h10v7H7l-3 3z', duplicates: 'M3 3h7v7H3zM6 6h7v7H6z', rules: 'M3 4h2M7 4h6M3 8h2M7 8h6M3 12h2M7 12h6', log: 'M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3zM8 5v3h3', dashboard: 'M3 13V8m4 5V4m4 9V6M2 13h12', export: 'M8 10V2m-3 3 3-3 3 3M3 12v2h10v-2' };
const icon = k => h('span', { class: 'ico', 'aria-hidden': 'true', html: `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[k]}"/></svg>` });
const NAV = [['', 'Import'], ['overview', 'Overview'], ['bills', 'Bills'], ['review', 'Needs review'], ['duplicates', 'Duplicates'], ['rules', 'Rules'], ['log', 'Change log'], ['dashboard', 'Dashboard'], ['export', 'Export']];
function renderNav(view, m) {
  const nav = $('#nav'); nav.innerHTML = '';
  const counts = m ? { bills: m.bills.length, review: m.records.filter(r => r.reasons.length).length - m.decidedCount, duplicates: m.dups.length, rules: E.MERCHANTS.length + S.rules.aliases.length, log: m.changes.length + m.userChanges.length } : {};
  for (const [v, label] of NAV) { if (!m && v) continue; nav.append(h('a', { href: '#/' + v, 'aria-current': view === v ? 'page' : null, title: label, onclick: () => { nav.classList.remove('open'); } }, icon(v), h('span', {}, v === '' && m ? 'Import another' : label), counts[v] !== undefined ? h('span', { class: 'cnt' }, counts[v].toLocaleString()) : null)); }
  if (m) nav.append(h('button', { class: 'btn btn-ghost btn-sm collapse', onclick: () => { S.ui.navCollapsed = !S.ui.navCollapsed; persist(); render(); }, 'aria-label': S.ui.navCollapsed ? 'Expand navigation' : 'Collapse navigation', title: S.ui.navCollapsed ? 'Expand navigation' : 'Collapse navigation' }, h('span', { class: 'ico', 'aria-hidden': 'true' }, S.ui.navCollapsed ? '»' : '«'), h('span', {}, S.ui.navCollapsed ? '' : 'collapse')));
}
// Every render replaces the page's elements, so the control a keyboard user was on disappears and focus drops to <body>:
// no focus ring, and Tab starts again from the top of the page (round-3 audit, 2026-09-16). render() puts focus back on the
// same control (same attribute, or same label and position among its twins) or, when that control is gone, on the page heading.
function focusKey(el) {
  if (!el || el === document.body || el === document.documentElement) return null;
  const scope = el.parentElement && el.parentElement.closest('[id]'), within = scope ? '#' + CSS.escape(scope.id) + ' ' : '', tag = el.tagName.toLowerCase();
  const quote = v => '"' + v.replace(/["\\]/g, '\\$&') + '"';
  const tries = ['id', 'data-id', 'data-key', 'data-sort', 'href', 'name'].filter(a => el.getAttribute(a)).map(a => within + tag + '[' + a + '=' + quote(el.getAttribute(a)) + ']');
  const kind = tag + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).map(c => CSS.escape(c)).join('.') : '');
  // a control inside a record (an element with data-id, such as a table row) is looked for in that same record first, then in
  // the record now at its place in the list (the next one moved up), and only then does focus go to the heading
  const rec = el.parentElement && el.parentElement.closest('[data-id]'), recs = rec ? within + rec.tagName.toLowerCase() + '[data-id]' : null;
  const recId = rec && rec.getAttribute('data-id'), recAt = rec ? [...document.querySelectorAll(recs)].indexOf(rec) : -1, inRec = rec ? [...rec.querySelectorAll(kind)].indexOf(el) : -1;
  const index = [...document.querySelectorAll(within + kind)].indexOf(el);
  const find = () => {
    for (const s of tries) { const x = document.querySelector(s); if (x) return x; }
    if (rec) { const r = document.querySelector(within + rec.tagName.toLowerCase() + '[data-id=' + quote(recId) + ']') || document.querySelectorAll(recs)[recAt]; return r ? r.querySelectorAll(kind)[inRec] || null : null; }
    return index < 0 ? null : document.querySelectorAll(within + kind)[index] || null;
  };
  find.caret = typeof el.selectionStart === 'number' ? [el.selectionStart, el.selectionEnd] : null;   // a text field keeps its caret
  return find;
}
function restoreFocus(find) {
  if (!find || (document.activeElement && document.activeElement !== document.body)) return;
  let el = find();
  const heading = () => { for (const sel of ['#main h1', '#main h2', '#main']) { const x = [...document.querySelectorAll(sel)].find(y => { const r = y.getBoundingClientRect(); return r.width > 2 && r.height > 2; }); if (x) { if (!x.hasAttribute('tabindex')) x.setAttribute('tabindex', '-1'); return x; } } return null; };
  if (!el || !el.getClientRects().length) el = heading();
  if (el) { el.focus(); if (document.activeElement !== el && (el = heading())) el.focus(); }   // a disabled control does not take focus
  if (el && find.caret && el.setSelectionRange) try { el.setSelectionRange(find.caret[0], find.caret[1]); } catch (e) { /* not a text field */ }
}
function render() {
  const active = document.activeElement, inQueue = !!(active && active.closest && active.closest('#queue'));
  const find = focusKey(active); renderPage();
  // one primary button per screen (v1 §9.1): the top-bar "Start review" steps aside where the page shows its own
  // (the overview plate, the review inspector, Export, the landing page's load button)
  if ([...document.querySelectorAll('#main .btn-primary, #inspector .btn-primary')].some(b => b.getClientRects().length)) $('#primary-action').hidden = true;
  // the review queue moves its own selection (auto-advance after a, c, d or x): focus in the queue follows the selected row,
  // as j and k already do, so the ring never sits on a row the next shortcut will not act on (designer ruling 2026-09-16 17:05 Q4)
  const selected = inQueue && $('#queue li[aria-selected="true"]');
  if (selected) selected.focus(); else restoreFocus(find);
}
function renderPage() {
  const { view, p } = route(); const main = $('#main'); main.innerHTML = '';
  const shell = $('#shell'); shell.classList.toggle('nav-collapsed', S.ui.navCollapsed);
  $('#pill-long').textContent = S.rows ? (S.source.kind === 'sample' ? ` · synthetic data · seed ${S.source.seed}` : ' · your file · parsed in this tab') : ' · synthetic data';
  $('#pill').title = S.rows && S.source.kind === 'file' ? 'Your file was parsed in this tab and never uploaded. Still a demo: no accounting-system integration.' : 'All figures come from generated data, not a client.';
  $('#sections').hidden = !S.rows; $('#primary-action').hidden = !S.rows;
  if (!S.rows && view) { location.replace('#/'); toast('Load data first'); return; }
  const m = S.rows ? M() : null; renderNav(view, m);
  let ctx = { actions: true };
  if (!m || view === '') { viewLanding(main); shell.classList.add('no-inspector'); renderInspector(m, null, {}); document.title = 'Bill Bench'; return; }
  const pa = $('#primary-action'); const left = m.records.filter(r => r.reasons.length).length - m.decidedCount; const narrow = matchMedia('(max-width:639px)').matches; pa.textContent = left > 0 ? (narrow ? `Review (${left})` : `Start review (${left})`) : (narrow ? 'Export' : 'Export workbook'); pa.onclick = () => go(left > 0 ? 'review' : 'export');
  ({ overview: viewOverview, bills: viewBills, review: viewReview, duplicates: viewDuplicates, rules: viewRules, log: viewLog, dashboard: viewDashboard, export: viewExport }[view] || viewOverview)(main, m, p) ;
  if (view === 'bills' || view === 'review') { const r = m.byId[p.get('i')] || (view === 'review' ? m.byId[(filteredQueue(m, p.get('reason') || 'all').find(x => !x.decided) || filteredQueue(m, p.get('reason') || 'all')[0])?.id] : null); ctx = { queue: view === 'review' ? filteredQueue(m, p.get('reason') || 'all') : null, actions: true }; renderInspector(m, r, ctx); shell.classList.toggle('no-inspector', !r); $('#inspector').classList.toggle('open', !!r && (S.ui.inspectorOpen || !!p.get('i'))); }
  else { shell.classList.add('no-inspector'); $('#inspector').classList.remove('open'); renderInspector(m, null, {}); }
  document.title = 'Bill Bench · ' + (NAV.find(n => n[0] === view) || ['', 'Overview'])[1];
  main.querySelectorAll('.row-flash').forEach(x => x.classList.remove('row-flash'));
}
// Arrow keys, Home and End move between the options of a radio group or tab list and pick the one they land on (WAI-ARIA)
function roving(e) {
  const opt = e.target.closest('[role="radio"], [role="tab"]'), group = opt && opt.closest('[role="radiogroup"], [role="tablist"]');
  if (!group || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false;
  const all = [...group.querySelectorAll('[role="radio"], [role="tab"]')].filter(b => !b.disabled), i = all.indexOf(opt);
  const move = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
  const next = move ? all[(i + move + all.length) % all.length] : e.key === 'Home' ? all[0] : e.key === 'End' ? all[all.length - 1] : null;
  if (!next) return false;
  e.preventDefault(); next.focus(); if (next !== opt) next.click(); return true;
}
function keyHandler(e) {
  const t = e.target; if (t.closest('input, select, textarea, [contenteditable]') || document.querySelector('dialog[open]')) return;
  if (roving(e)) return;
  if (e.key === 'Enter' && t.closest('button, a[href], summary, [role="button"], [role="tab"]')) return;   // the control's own Enter, not a queue shortcut
  if (e.key === '?') { e.preventDefault(); helpDialog(); return; }
  if (e.key === 'Escape') { if ($('#nav').classList.contains('open')) { $('#nav').classList.remove('open'); return; } if (route().p.get('i')) { setParam('i', null); return; } }
  const { view, p } = route(); if (view !== 'review' || !S.rows) return;
  const m = M(), queue = filteredQueue(m, p.get('reason') || 'all'), cur = m.byId[p.get('i')] || queue.find(x => !x.decided) || queue[0]; if (!cur) return;
  const i = queue.indexOf(cur);
  if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); const n = queue[Math.min(queue.length - 1, i + 1)]; if (n) { setParam('i', n.id); setTimeout(() => $(`#queue li[data-id="${CSS.escape(n.id)}"]`)?.focus(), 0); } }
  else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); const n = queue[Math.max(0, i - 1)]; if (n) { setParam('i', n.id); setTimeout(() => $(`#queue li[data-id="${CSS.escape(n.id)}"]`)?.focus(), 0); } }
  else if (e.key === 'Enter') { setParam('i', cur.id); setTimeout(focusInspector, 0); }
  else if (['a', 'c', 'd', 'x'].includes(e.key)) { const b = $(`#inspector [data-key="${e.key}"]`); if (b) { e.preventDefault(); b.click(); } }
  else if (e.key === 'u') { const d = S.decisions.filter(x => !x.undoneBy && x.action !== 'undo').pop(); if (d) { undoDecision(d.id); toast('Undid last decision'); render(); } }
}
async function init() {
  const root = document.documentElement, tb = $('#theme');
  Appearance.bindToggle(tb);   // ◐ switches light/dark only (appearance.js)
  Appearance.bindSettings($('#nl-settings-button'));   // the gear: palette + light/dark
  $('#help').addEventListener('click', helpDialog);
  $('#sections').addEventListener('click', () => $('#nav').classList.toggle('open'));
  document.addEventListener('keydown', keyHandler);
  window.addEventListener('hashchange', render);
  $('.skip').addEventListener('click', e => { e.preventDefault(); $('#main').focus(); });   // "#main" in the address would be read as a view
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 150); });
  const saved = await DB.get('state');
  const url = new URLSearchParams(location.search);
  if (saved && saved.rows) { Object.assign(S, { source: saved.source, rows: saved.rows, rules: saved.rules || S.rules, decisions: saved.decisions || [] }); Object.assign(S.ui, saved.ui || {}); invalidate(); toast(`Restored ${saved.rows.length} rows and ${plural(S.decisions.filter(d => !d.undoneBy && d.action !== 'undo').length, 'decision')} from this browser`, { ms: 5000 }); if (!location.hash || location.hash === '#/') location.replace('#/overview'); }
  else if (url.get('demo') === '1' || url.get('demo') === 'quiet') { await loadSample(parseInt(url.get('seed') || '42', 10) || 42); if (!location.hash || location.hash === '#/') location.replace('#/overview'); }
  render();
}
window.BillBench = { state: S, model: M, exportWorkbook, exportLedger, exportInput, runChecks, loadSample };
init();
})();
