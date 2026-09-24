/* bills-engine.js — browser + Node port of demo.py (bill-categoriser).
   Same rules, same numbers: proven by check-web.mjs against the Python CLI (ledger bytes,
   workbook cells, and `python3 demo.py check` accepting a browser-built output folder).
   No dependencies. ZIP inflate uses DecompressionStream('deflate-raw'). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BillsEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

const HEADERS = [['Invoice','Vendor','Date','Amount'],['Bill ID','Merchant name','Invoice date','Total CAD'],['Reference','Payee','Billed on','Gross amount']];
const SHEETS = ['Export A','Export B','Export C'];
const MERCHANTS = [['Demo Supply 01','Supplies'],['Demo Utility 02','Utilities'],['Demo Software 03','Software'],['Demo Lease 04','Rent'],['Demo Carrier 05','Transport'],['Demo Other 06','Uncategorised']];
const ALIASES = {};
for (const [m] of MERCHANTS) ALIASES[m.toLowerCase().replace(/[^a-z0-9]/g, '')] = m;
const CATEGORY = Object.fromEntries(MERCHANTS);
const DEFAULT_HIGH_CENTS = 250000;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/* ---------- Python-compatible random.Random (MT19937 + init_by_array + _randbelow) ---------- */
class PyRandom {
  constructor(seed) {
    this.mt = new Uint32Array(624); this.mti = 625;
    let n = Math.abs(Math.trunc(seed)); const key = [];
    do { key.push(n % 4294967296); n = Math.floor(n / 4294967296); } while (n > 0);
    this.initByArray(key);
  }
  initGenrand(s) { const mt = this.mt; mt[0] = s >>> 0; for (let i = 1; i < 624; i++) { const p = mt[i-1] ^ (mt[i-1] >>> 30); mt[i] = (Math.imul(1812433253, p) + i) >>> 0; } this.mti = 624; }
  initByArray(key) {
    this.initGenrand(19650218); const mt = this.mt, N = 624; let i = 1, j = 0, k = Math.max(N, key.length);
    for (; k; k--) { const p = mt[i-1] ^ (mt[i-1] >>> 30); mt[i] = ((mt[i] ^ Math.imul(p, 1664525)) + key[j] + j) >>> 0; i++; j++; if (i >= N) { mt[0] = mt[N-1]; i = 1; } if (j >= key.length) j = 0; }
    for (k = N - 1; k; k--) { const p = mt[i-1] ^ (mt[i-1] >>> 30); mt[i] = ((mt[i] ^ Math.imul(p, 1566083941)) - i) >>> 0; i++; if (i >= N) { mt[0] = mt[N-1]; i = 1; } }
    mt[0] = 0x80000000; this.mti = N;
  }
  genrand() {
    const mt = this.mt, N = 624, M = 397, MATRIX = 0x9908b0df, UPPER = 0x80000000, LOWER = 0x7fffffff; let y;
    if (this.mti >= N) {
      let kk = 0;
      for (; kk < N - M; kk++) { y = (mt[kk] & UPPER) | (mt[kk+1] & LOWER); mt[kk] = mt[kk+M] ^ (y >>> 1) ^ ((y & 1) ? MATRIX : 0); }
      for (; kk < N - 1; kk++) { y = (mt[kk] & UPPER) | (mt[kk+1] & LOWER); mt[kk] = mt[kk+(M-N)] ^ (y >>> 1) ^ ((y & 1) ? MATRIX : 0); }
      y = (mt[N-1] & UPPER) | (mt[0] & LOWER); mt[N-1] = mt[M-1] ^ (y >>> 1) ^ ((y & 1) ? MATRIX : 0); this.mti = 0;
    }
    y = mt[this.mti++]; y ^= y >>> 11; y ^= (y << 7) & 0x9d2c5680; y ^= (y << 15) & 0xefc60000; y ^= y >>> 18; return y >>> 0;
  }
  getrandbits(k) { if (k <= 0) return 0; if (k > 32) throw new Error('getrandbits > 32 not needed'); const r = this.genrand(); return k === 32 ? r : r >>> (32 - k); }
  randbelow(n) { const k = 32 - Math.clz32(n); let r = this.getrandbits(k); while (r >= n) r = this.getrandbits(k); return r; }
  randint(a, b) { return a + this.randbelow(b - a + 1); }
}

/* ---------- Python-compatible formatting ---------- */
class PyFloat { constructor(v) { this.v = v; } toString() { return pyFloatRepr(this.v); } valueOf() { return this.v; } }
const F = v => new PyFloat(v);
function pyFloatRepr(x) { if (Object.is(x, -0)) return '-0.0'; if (Number.isInteger(x) && Math.abs(x) < 1e16) return x + '.0'; return String(x); }
function moneyStr(cents, grouping) {
  const neg = cents < 0, a = Math.abs(cents); let int = String(Math.floor(a / 100)); const frac = String(a % 100).padStart(2, '0');
  if (grouping) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + int + '.' + frac;
}
function thresholdLabel(cents) { return moneyStr(cents, true).replace(/0+$/, '').replace(/\.$/, ''); }
function pyStr(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '"') out += '\\"'; else if (ch === '\\') out += '\\\\'; else if (ch === '\n') out += '\\n'; else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t'; else if (ch === '\b') out += '\\b'; else if (ch === '\f') out += '\\f';
    else if (c < 0x20 || c > 0x7e) {
      if (c > 0xffff) { const v = c - 0x10000; out += '\\u' + (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + '\\u' + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0'); }
      else out += '\\u' + c.toString(16).padStart(4, '0');
    } else out += ch;
  }
  return out + '"';
}
/* json.dumps(v, indent=2, ensure_ascii=True, sort_keys=True) */
function pyJson(v, indent = 0) {
  const pad = ' '.repeat(indent), pad2 = ' '.repeat(indent + 2);
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof PyFloat) return pyFloatRepr(v.v);
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : pyFloatRepr(v);
  if (typeof v === 'string') return pyStr(v);
  if (Array.isArray(v)) return v.length ? '[\n' + v.map(x => pad2 + pyJson(x, indent + 2)).join(',\n') + '\n' + pad + ']' : '[]';
  const keys = Object.keys(v).sort();
  return keys.length ? '{\n' + keys.map(k => pad2 + pyStr(k) + ': ' + pyJson(v[k], indent + 2)).join(',\n') + '\n' + pad + '}' : '{}';
}

/* ---------- Rules (verbatim port of demo.py) ---------- */
function money(raw) {
  let s = String(raw).trim();
  if (!s) throw new Error('missing amount');
  const neg = s.startsWith('(') && s.endsWith(')');
  if (neg) s = s.slice(1, -1);
  s = s.replace(/^(?:CAD\s*|\$)/, '').trim();
  const m = /^(-?)(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d{2}))?$/.exec(s);
  if (!m) throw new Error('invalid amount or unsupported currency');
  const negative = m[1] === '-';
  if (neg && negative) throw new Error('conflicting signs');
  const cents = parseInt(m[2].replace(/,/g, ''), 10) * 100 + (m[3] ? parseInt(m[3], 10) : 0);
  return cents * (negative ? -1 : 1) * (neg ? -1 : 1);
}
const D_ = '(3[01]|[12]\\d|0[1-9]|[1-9]| [1-9])', M_ = '(1[0-2]|0[1-9]|[1-9])', Y_ = '(\\d{4})';
const DATE_FORMATS = [
  [new RegExp('^' + Y_ + '-' + M_ + '-' + D_ + '$'), m => [m[1], m[2], m[3]]],
  [new RegExp('^' + Y_ + '/' + M_ + '/' + D_ + '$'), m => [m[1], m[2], m[3]]],
  [new RegExp('^' + D_ + '-(' + MONTHS.join('|') + ')-' + Y_ + '$', 'i'), m => [m[3], String(MONTHS.findIndex(x => x.toLowerCase() === m[2].toLowerCase()) + 1), m[1]]],
];
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function date(raw) {
  const s = String(raw).trim();
  if (!s) throw new Error('missing date');
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) throw new Error('ambiguous date: slash order unspecified');
  for (const [rx, pick] of DATE_FORMATS) {
    const m = rx.exec(s); if (!m) continue;
    const [y, mo, d] = pick(m).map(x => parseInt(String(x).trim(), 10));
    if (y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)) return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  throw new Error('invalid date');
}
function generate(seed) {
  const rng = new PyRandom(seed); const out = [];
  for (let i = 0; i < 120; i++) {
    const [m] = MERCHANTS[i % 6];
    let vendor = [m, m.toUpperCase(), '  ' + m.toLowerCase() + '  ', m.replace(/ /g, '-')][i % 4];
    const month = i % 12 + 1, day = rng.randint(1, 27);
    const mm = String(month).padStart(2, '0'), dd = String(day).padStart(2, '0');
    let ds = [`2025-${mm}-${dd}`, `2025/${mm}/${dd}`, `${dd}-${MONTHS[month - 1]}-2025`][i % 3];
    const cents = rng.randint(1200, 280000) * (i % 19 === 0 ? -1 : 1);
    let amt = [`CAD ${moneyStr(cents, true)}`, `$${moneyStr(cents, true)}`, moneyStr(cents, false)][i % 3];
    if (i === 0) amt = '(CAD 1,250.00)';
    if (i === 5 || i === 17) ds = '';
    if (i === 8 || i === 29) amt = '';
    if (i === 22) ds = '2025-02-30';
    if (i === 24) amt = 'CAD 12,34.00';
    if (i === 31) ds = '03/04/2025';
    if (i === 32) amt = 'USD 45.00';
    if (i === 35) vendor = '=SYNTHETIC_FORMULA_TEXT()';
    if (i === 40) amt = 'CAD 0.00';
    out.push([`SYN-${String(i + 1).padStart(4, '0')}`, vendor, ds, amt]);
  }
  for (const i of [1, 12, 44]) out.push(out[i].slice());
  for (const i of [2, 13]) { const v = out[i].slice(); v[0] += '-COPY'; v[1] = v[1].toUpperCase().trim(); out.push(v); }
  const sheets = {}; SHEETS.forEach((s, n) => { sheets[s] = out.slice(n * 42, (n + 1) * 42); }); return sheets;
}
function readInput(workbook, filename) {
  const rows = [];
  SHEETS.forEach((sheet, si) => {
    if (!(sheet in workbook)) throw new Error('missing source sheet ' + sheet);
    const header = workbook[sheet][4];
    if (!header || header.length !== 4 || header.some((v, i) => v !== HEADERS[si][i])) throw new Error('unexpected headers ' + sheet);
    for (const rn of Object.keys(workbook[sheet]).map(Number).sort((a, b) => a - b)) {
      if (rn < 5) continue;
      const vals = workbook[sheet][rn].slice(); while (vals.length < 4) vals.push(null);
      if (vals.length !== 4 || vals.some(v => v && typeof v === 'object')) throw new Error('input formula or unsupported columns');
      rows.push({ id: `${si + 1}:${rn}`, raw: vals.map(v => v === null ? '' : String(v)), source_file: filename, source_sheet: sheet, source_row: rn, headers: HEADERS[si] });
    }
  });
  return rows;
}
function reconcile(records) {
  const counts = {}, cents = {};
  for (const s of ['clean', 'duplicate', 'unparseable']) { counts[s] = records.filter(r => r.status === s).length; cents[s] = records.filter(r => r.status === s).reduce((a, r) => a + (r.cents || 0), 0); }
  return { count: records.length, counts, cents, known_input_cents: records.reduce((a, r) => a + (r.cents || 0), 0), unknown_amount_rows: records.filter(r => r.cents === null).length };
}
function clean(rows, highCents, extra) {
  const aliases = extra && extra.aliases ? { ...ALIASES, ...extra.aliases } : ALIASES;
  const categories = extra && extra.categories ? { ...CATEGORY, ...extra.categories } : CATEGORY;
  const userCats = extra && extra.categories ? extra.categories : {};
  const records = [], changes = [], seen = new Map(), near = new Map();
  for (const row of rows) {
    const [invoice, rawM, rawD, rawA] = row.raw; const reasons = [];
    const change = (field, before, after, rule) => { if (before !== after) changes.push({ id: row.id, field, before, after, rule, source_file: row.source_file, source_sheet: row.source_sheet, source_row: row.source_row }); };
    ['invoice', 'merchant', 'date', 'amount_cad'].forEach((nw, i) => change('header', row.headers[i], nw, 'header alias map'));
    const invoice2 = invoice.trim(); change('invoice', invoice, invoice2, 'trim surrounding whitespace');
    const merchant = aliases[rawM.toLowerCase().replace(/[^a-z0-9]/g, '')] ?? rawM.trim();
    change('merchant', rawM, merchant, 'synthetic merchant alias map');
    const cat = categories[merchant] ?? 'Uncategorised';
    change('category', '', cat, cat !== 'Uncategorised' ? (merchant in userCats ? 'reviewer alias rule' : 'exact merchant rule') : 'no rule; manual review');
    if (cat === 'Uncategorised') reasons.push('unmapped merchant');
    let cents = null, d = null;
    try { cents = money(rawA); change('amount', rawA, moneyStr(cents, false), 'CAD symbols, grouping and refund sign'); } catch (e) { reasons.push(e.message); }
    try { d = date(rawD); change('date', rawD, d, 'explicit non-ambiguous date format'); } catch (e) { reasons.push(e.message); }
    let status = cents !== null && d !== null ? 'clean' : 'unparseable', duplicate_of = null;
    if (status === 'clean') {
      const key = JSON.stringify([invoice2, merchant, d, cents]);
      if (seen.has(key)) { status = 'duplicate'; duplicate_of = seen.get(key); reasons.push('exact duplicate of ' + duplicate_of); }
      else { seen.set(key, row.id); const nk = JSON.stringify([merchant, d, cents]); if (near.has(nk)) reasons.push('possible duplicate of ' + near.get(nk) + '; retained for review'); else near.set(nk, row.id); }
    }
    if (cents !== null && Math.abs(cents) >= highCents) reasons.push('high amount: absolute CAD >= ' + thresholdLabel(highCents));
    change('disposition', 'input', status, 'partition; never discard a source row');
    records.push({ ...row, invoice: invoice2, merchant, date: d, cents, category: cat, status, duplicate_of, reasons });
  }
  return { records, changes, reconciliation: reconcile(records) };
}
function serial(iso) { const [y, m, d] = iso.split('-').map(Number); return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000); }
function workbookTables(model) {
  const rows = model.records, bill = rows.filter(r => r.status === 'clean'), bad = rows.filter(r => r.reasons.length), dups = rows.filter(r => r.status === 'duplicate');
  const src = r => [r.source_file, r.source_sheet, r.source_row];
  const amt = r => r.cents === null ? null : F(r.cents / 100);
  const dates = r => r.date ? { date: r.date } : null;
  const fx = (formula, value) => ({ formula, value });
  const sumCents = rs => rs.reduce((a, r) => a + r.cents, 0);
  const result = {
    'Bills': bill.map(r => [r.id, r.invoice, dates(r), r.merchant, r.category, amt(r), r.raw[1], ...src(r), r.reasons.join('; ')]),
    'Needs review': bad.map(r => [r.id, r.status, r.reasons.join('; '), r.invoice, r.raw[1], r.raw[2], r.raw[3], amt(r), ...src(r)]),
    'Duplicates': dups.map(r => [r.id, r.duplicate_of, r.invoice, r.merchant, dates(r), amt(r), ...src(r)]),
    'Change log': model.changes.map(c => [c.id, c.field, c.before, c.after, c.rule, c.source_file, c.source_sheet, c.source_row]),
  };
  const rec = model.reconciliation, end = bill.length + 4, sum = [];
  sum.push(['Retained bills', fx(`SUM('Bills'!F5:F${end})`, F(rec.cents.clean / 100)), bill.length, 'Includes possible duplicates; resolve review before posting.']);
  sum.push(['Exact duplicates excluded', fx(`SUM('Duplicates'!F5:F${dups.length + 4})`, F(rec.cents.duplicate / 100)), dups.length, 'Excluded from Bills; original rows retained.']);
  sum.push(['Unparseable: known amounts', fx(`SUMIFS('Needs review'!H5:H${bad.length + 4},'Needs review'!B5:B${bad.length + 4},"unparseable")`, F(rec.cents.unparseable / 100)), rec.counts.unparseable, 'Not included in monthly totals.']);
  sum.push(['All known input amounts', F(rec.known_input_cents / 100), rows.length, 'Independent source control, before duplicate exclusion.']);
  sum.push(['Reconciliation difference', fx('(ROUND(B5*100,0)+ROUND(B6*100,0)+ROUND(B7*100,0)-ROUND(B8*100,0))/100', 0), null, 'Exact cents; must equal zero. Missing amounts stay unknown.']);
  sum.push(['Unknown amounts', null, rec.unknown_amount_rows, 'Blank amounts are unknown, never treated as real zero.']);
  sum.push(['Review rows', null, bad.length, 'Every flagged row, including duplicates.']);
  sum.push(['MONTHLY TOTALS', null, null, 'Retained bills only; CAD.']);
  for (let mo = 1; mo <= 12; mo++) {
    const mm = String(mo).padStart(2, '0'), s = serial(`2025-${mm}-01`), e = serial(mo === 12 ? '2026-01-01' : `2025-${String(mo + 1).padStart(2, '0')}-01`);
    const relevant = bill.filter(r => r.date.startsWith(`2025-${mm}`));
    sum.push([`2025-${mm}`, fx(`SUMIFS('Bills'!F5:F${end},'Bills'!C5:C${end},">=${s}",'Bills'!C5:C${end},"<${e}")`, F(sumCents(relevant) / 100)), relevant.length, null]);
  }
  sum.push(['CATEGORY TOTALS', null, null, null]);
  for (const category of [...new Set(Object.values(CATEGORY))].sort()) {
    const relevant = bill.filter(r => r.category === category);
    sum.push([category, fx(`SUMIFS('Bills'!F5:F${end},'Bills'!E5:E${end},A${sum.length + 5})`, F(sumCents(relevant) / 100)), relevant.length, null]);
  }
  sum.push(['MERCHANT TOTALS', null, null, 'Sorted by net retained amount at build time.']);
  const bySum = {}; for (const r of bill) bySum[r.merchant] = (bySum[r.merchant] || 0) + r.cents;
  const merchants = Object.keys(bySum).sort((a, b) => (bySum[b] - bySum[a]) || (a < b ? -1 : a > b ? 1 : 0));
  for (const m of merchants) {
    const relevant = bill.filter(r => r.merchant === m);
    sum.push([m, fx(`SUMPRODUCT(('Bills'!D5:D${end}=A${sum.length + 5})*'Bills'!F5:F${end})`, F(sumCents(relevant) / 100)), relevant.length, m === merchants[0] ? 'Largest merchant' : null]);
  }
  const high = model.high_amount_cents;
  sum.push(['HIGH BILLS | absolute CAD >= ' + thresholdLabel(high), null, null, 'Includes large refunds.']);
  for (const r of bill.slice().sort((a, b) => Math.abs(b.cents) - Math.abs(a.cents))) {
    if (Math.abs(r.cents) < high) continue;
    sum.push([r.invoice, fx(`'Bills'!F${5 + bill.indexOf(r)}`, amt(r)), null, r.merchant]);
  }
  result['Summary'] = sum; return result;
}

/* ---------- ZIP (stored + deflate read; stored write) ---------- */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
async function inflateRaw(raw) { const ds = new DecompressionStream('deflate-raw'); const w = ds.writable.getWriter(); w.write(raw); w.close(); return new Uint8Array(await new Response(ds.readable).arrayBuffer()); }
async function readZip(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const dec = new TextDecoder();
  let eocd = -1; for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a ZIP/XLSX file');
  const count = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true); const parts = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), loff = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nlen)); p += 46 + nlen + elen + clen;
    if (dv.getUint32(loff, true) !== 0x04034b50) throw new Error('bad local header');
    const start = loff + 30 + dv.getUint16(loff + 26, true) + dv.getUint16(loff + 28, true);
    const raw = bytes.subarray(start, start + csize);
    let data; if (method === 0) data = raw.slice(); else if (method === 8) data = await inflateRaw(raw); else throw new Error('unsupported ZIP compression ' + method);
    if (data.length !== usize) throw new Error('ZIP size mismatch: ' + name);
    if (name in parts) throw new Error('duplicate XLSX member name');
    parts[name] = data;
  }
  return parts;
}
function writeZip(parts) {
  const enc = new TextEncoder(), names = Object.keys(parts).sort(), chunks = [], central = []; let offset = 0;
  for (const name of names) {
    const data = parts[name], nb = enc.encode(name), crc = crc32(data);
    const lh = new Uint8Array(30 + nb.length), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(14, 0x2821, true); lv.setUint32(14 - 0, crc, true);
    lv.setUint16(12, 0x2821, true); lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true); lv.setUint16(26, nb.length, true); lh.set(nb, 30);
    const ch = new Uint8Array(46 + nb.length), cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(14, 0x2821, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true); cv.setUint16(28, nb.length, true); cv.setUint32(38, (0o600 << 16) >>> 0, true); cv.setUint32(42, offset, true); ch.set(nb, 46);
    chunks.push(lh, data); central.push(ch); offset += lh.length + data.length;
  }
  const cdStart = offset; let cdLen = 0; for (const c of central) { chunks.push(c); cdLen += c.length; }
  const eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, names.length, true); ev.setUint16(10, names.length, true); ev.setUint32(12, cdLen, true); ev.setUint32(16, cdStart, true); chunks.push(eocd);
  const out = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0)); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; } return out;
}

/* ---------- OOXML (same limited schema as xlsx_io.py) ---------- */
const decode = b => new TextDecoder().decode(b), encode = s => new TextEncoder().encode(s);
/* OOXML may carry a namespace prefix (templates use <x:row>, ElementTree output uses <row>); every tag regex tolerates both. */
const NSP = '(?:[\\w.-]+:)?';
const openTag = n => new RegExp('<' + NSP + n + '\\b([^>]*?)(?:/>|>([\\s\\S]*?)</' + NSP + n + '>)', 'g');
const oneTag = n => new RegExp('<' + NSP + n + '\\b[^>]*>([\\s\\S]*?)</' + NSP + n + '>');
function unesc(s) { return s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (_, e) => e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'" : String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))); }
function escText(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escAttr(s) { return escText(s).replace(/"/g, '&quot;'); }
function attrs(s) { const a = {}; for (const m of s.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) a[m[1]] = unesc(m[2]); return a; }
function colName(n) { let r = ''; while (n) { const q = Math.floor((n - 1) / 26), rem = (n - 1) % 26; r = String.fromCharCode(65 + rem) + r; n = q; } return r; }
function colIndex(ref) { let r = 0; for (const c of /^[A-Z]+/.exec(ref)[0]) r = r * 26 + c.charCodeAt(0) - 64; return r - 1; }
function sheetPaths(parts) {
  const targets = {};
  for (const m of decode(parts['xl/_rels/workbook.xml.rels']).matchAll(new RegExp('<' + NSP + 'Relationship\\b([^>]*?)/?>', 'g'))) { const a = attrs(m[1]); let t = a.Target || ''; t = t.startsWith('/') ? t.replace(/^\/+/, '') : 'xl/' + t; const segs = []; for (const s of t.split('/')) { if (s === '..') segs.pop(); else if (s && s !== '.') segs.push(s); } targets[a.Id] = segs.join('/'); }
  const out = {};
  for (const m of decode(parts['xl/workbook.xml']).matchAll(new RegExp('<' + NSP + 'sheet\\b([^>]*?)/?>', 'g'))) { const a = attrs(m[1]); out[a.name] = targets[a['r:id']]; }
  return out;
}
function itertext(xml) { return xml.replace(/<[^>]+>/g, ''); }
function parseWorkbook(parts) {
  let strings = [];
  if ('xl/sharedStrings.xml' in parts) strings = [...decode(parts['xl/sharedStrings.xml']).matchAll(new RegExp(oneTag('si').source, 'g'))].map(m => unesc(itertext(m[1])));
  const out = {};
  for (const [name, p] of Object.entries(sheetPaths(parts))) {
    const xml = decode(parts[p]); const rows = {};
    const sd = oneTag('sheetData').exec(xml); const body = sd ? sd[1] : '';
    for (const rm of body.matchAll(openTag('row'))) {
      const values = [];
      for (const cm of (rm[2] || '').matchAll(openTag('c'))) {
        const a = attrs(cm[1]), i = colIndex(a.r), inner = cm[2] || '';
        while (values.length < i + 1) values.push(null);
        const v = oneTag('v').exec(inner), f = new RegExp(oneTag('f').source + '|<' + NSP + 'f\\b[^>]*/>').exec(inner), kind = a.t;
        let value = v ? unesc(v[1]) : null;
        if (kind === 's') value = strings[parseInt(value, 10)];
        else if (kind === 'inlineStr') { const is = oneTag('is').exec(inner); value = is ? unesc(itertext(is[1])) : ''; }
        else if (value !== null && kind !== 'str' && kind !== 'e') value = parseFloat(value);
        if (f) value = { formula: f[1] === undefined ? null : unesc(f[1]), value };
        values[i] = value;
      }
      rows[parseInt(attrs(rm[1]).r, 10)] = values;
    }
    out[name] = rows;
  }
  return out;
}
function cellXml(P, ref, s, value) {
  if (value && typeof value === 'object' && 'date' in value) value = serial(value.date);
  if (value && typeof value === 'object' && 'formula' in value) return `<${P}c r="${ref}" s="${s}"><${P}f>${escText(value.formula)}</${P}f><${P}v>${escText(String(value.value))}</${P}v></${P}c>`;
  if (value instanceof PyFloat || typeof value === 'number') return `<${P}c r="${ref}" s="${s}"><${P}v>${String(value)}</${P}v></${P}c>`;
  return `<${P}c r="${ref}" s="${s}" t="inlineStr"><${P}is><${P}t xml:space="preserve">${escText(String(value))}</${P}t></${P}is></${P}c>`;
}
function fill(templateParts, sheets) {
  const parts = { ...templateParts };
  for (const [name, p] of Object.entries(sheetPaths(parts))) {
    let xml = decode(parts[p]);
    const sd = new RegExp('<(' + NSP + ')sheetData\\b[^>]*>([\\s\\S]*?)</' + NSP + 'sheetData>|<(' + NSP + ')sheetData\\b[^>]*/>').exec(xml);
    if (!sd) throw new Error('template sheet without sheetData: ' + name);
    const P = sd[1] ?? sd[3] ?? ''; const sdBody = sd[2] || '';
    const style = {}; const kept = [];
    for (const rm of sdBody.matchAll(openTag('row'))) {
      const rn = parseInt(attrs(rm[1]).r, 10);
      for (const cm of (rm[2] || '').matchAll(openTag('c'))) { const a = attrs(cm[1]); style[rn + ':' + colIndex(a.r)] = a.s ?? '0'; }
      if (rn < 5) kept.push(rm[0]);
    }
    if (!(name in sheets)) throw new Error('no table for sheet ' + name);
    const records = sheets[name]; const rowsXml = [];
    records.forEach((values, k) => {
      const rn = k + 5; let cells = '';
      values.forEach((value, cn) => { if (value === null || value === undefined) return; cells += cellXml(P, colName(cn + 1) + rn, style['5:' + cn] ?? '0', value); });
      rowsXml.push(`<${P}row r="${rn}" ht="29" customHeight="1">${cells}</${P}row>`);
    });
    const width = Math.max(1, ...records.map(v => v.length));
    xml = xml.slice(0, sd.index) + `<${P}sheetData>` + kept.join('') + rowsXml.join('') + `</${P}sheetData>` + xml.slice(sd.index + sd[0].length);
    xml = xml.replace(new RegExp('<' + NSP + 'dimension\\b([^>]*?)/?>'), (m0, a) => `<${P}dimension ${a.trim().replace(/ref="[^"]*"/, `ref="A1:${colName(width)}${records.length + 4}"`)}/>`);
    const af = `A4:${colName(width)}${Math.max(5, records.length + 4)}`;
    if (new RegExp('<' + NSP + 'autoFilter\\b').test(xml)) xml = xml.replace(new RegExp('<' + NSP + 'autoFilter\\b([^>]*?)(/?)>'), (m0, a, sl) => `<${P}autoFilter ${a.trim().replace(/ref="[^"]*"/, `ref="${af}"`)}${sl}>`);
    else xml = xml.replace(`</${P}sheetData>`, `</${P}sheetData><${P}autoFilter ref="${af}"/>`);
    parts[p] = encode(xml);
  }
  return parts;
}

/* ---------- Pipeline ---------- */
async function build(templates, seed = 42, highCents = DEFAULT_HIGH_CENTS) {
  const dirty = writeZip(fill(await readZip(templates.input), generate(seed)));
  const rows = readInput(parseWorkbook(await readZip(dirty)), 'dirty-input.xlsx');
  const model = clean(rows, highCents); model.seed = seed; model.high_amount_cents = highCents;
  const cleaned = writeZip(fill(await readZip(templates.output), workbookTables(model)));
  return { dirty, ledger: pyJson(model) + '\n', cleaned, model };
}
async function cleanWorkbook(bytes, filename, templateOutput, highCents = DEFAULT_HIGH_CENTS) {
  const rows = readInput(parseWorkbook(await readZip(bytes)), filename);
  const model = clean(rows, highCents); model.seed = null; model.high_amount_cents = highCents;
  const cleaned = templateOutput ? writeZip(fill(await readZip(templateOutput), workbookTables(model))) : null;
  return { model, cleaned, ledger: pyJson(model) + '\n' };
}

return { HEADERS, SHEETS, MERCHANTS, ALIASES, CATEGORY, DEFAULT_HIGH_CENTS, PyRandom, PyFloat, pyJson, pyFloatRepr, moneyStr, thresholdLabel,
  money, date, generate, readInput, clean, reconcile, workbookTables, serial, crc32, readZip, writeZip, parseWorkbook, fill, sheetPaths, build, cleanWorkbook };
});
