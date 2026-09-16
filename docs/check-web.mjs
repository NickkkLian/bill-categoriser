// check-web.mjs — proves docs/bills-engine.js (the browser rules) == demo.py (the CLI rules): RNG stream, generated rows, ledger bytes, workbook cells,
// and the Python checker accepting a browser-built output folder (plus a negative control that must fail).
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const E = require('./bills-engine.js');  // the same file the page loads
const REPO = process.argv[2] || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const results = []; let failed = 0;
const check = (name, ok, detail = '') => { results.push([ok ? 'PASS' : 'FAIL', name, detail]); if (!ok) failed++; };
const py = (code, ...args) => { const r = spawnSync('python3', ['-B', '-', ...args], { cwd: REPO, input: code, encoding: 'utf-8', maxBuffer: 1 << 28 }); if (r.status !== 0) throw new Error('python failed: ' + r.stderr); return r.stdout; };
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const templates = { input: fs.readFileSync(path.join(REPO, 'templates/input-template.xlsx')), output: fs.readFileSync(path.join(REPO, 'templates/output-template.xlsx')) };
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bill-parity-'));

try {
// A. RNG stream
{
  const seeds = [42, 17, 0, 1, 2147483648, 123456789];
  const ref = JSON.parse(py(`import json,random,sys\nout={}\nfor s in ${JSON.stringify(seeds)}:\n r=random.Random(s);out[str(s)]=[r.randint(1,27) if i%2==0 else r.randint(1200,280000) for i in range(2000)]\nprint(json.dumps(out))`));
  let ok = true;
  for (const s of seeds) { const r = new E.PyRandom(s); const mine = []; for (let i = 0; i < 2000; i++) mine.push(i % 2 === 0 ? r.randint(1, 27) : r.randint(1200, 280000)); if (!deepEq(mine, ref[String(s)])) ok = false; }
  check('A. PyRandom.randint stream == Python random.Random (6 seeds × 2000 draws)', ok);
}
// B. generate(seed)
{
  const seeds = [42, 17, 3];
  const ref = JSON.parse(py(`import json,demo\nprint(json.dumps({str(s):demo.generate(s) for s in ${JSON.stringify(seeds)}}))`));
  check('B. generate(seed) rows == demo.generate (seeds 42/17/3)', seeds.every(s => deepEq(E.generate(s), ref[String(s)])));
}
// C. ledger bytes (seed 42 vs delivered; seeds 17/3 vs fresh Python builds)
const js42 = await E.build(templates, 42);
{
  const delivered = fs.readFileSync(path.join(REPO, 'output/ledger.json'), 'utf-8');
  check('C1. seed 42 ledger.json bytes == delivered output/ledger.json', js42.ledger === delivered, `${js42.ledger.length} chars`);
  for (const s of [17, 3]) {
    const out = path.join(tmpRoot, 'py-seed-' + s);
    const r = spawnSync('python3', ['-B', 'demo.py', 'build', '--seed', String(s), '--out', out], { cwd: REPO, encoding: 'utf-8' });
    const jsb = await E.build(templates, s);
    check(`C2. seed ${s} ledger bytes == python build --seed ${s}`, r.status === 0 && jsb.ledger === fs.readFileSync(path.join(out, 'ledger.json'), 'utf-8'));
  }
}
// D. reader: Python-built dirty-input.xlsx (stored) and a deflate-recompressed copy → same ledger
{
  const stored = fs.readFileSync(path.join(REPO, 'output/dirty-input.xlsx'));
  const r1 = await E.cleanWorkbook(stored, 'dirty-input.xlsx', null); r1.model.seed = 42;
  check('D1. JS reads Python-built stored XLSX → identical ledger', E.pyJson(r1.model) + '\n' === js42.ledger);
  const deflated = path.join(tmpRoot, 'dirty-deflated.xlsx');
  py(`import zipfile,sys\nsrc=zipfile.ZipFile('output/dirty-input.xlsx');dst=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)\nfor n in src.namelist(): dst.writestr(n,src.read(n))\ndst.close()`, deflated);
  const r2 = await E.cleanWorkbook(fs.readFileSync(deflated), 'dirty-input.xlsx', null); r2.model.seed = 42;
  check('D2. JS reads deflate-compressed XLSX (DecompressionStream) → identical ledger', E.pyJson(r2.model) + '\n' === js42.ledger);
}
// E. workbook tables (cell values/formulas/dates) == Python workbook_tables
{
  const enc = v => v === null || v === undefined ? null : v instanceof E.PyFloat ? { float: E.pyFloatRepr(v.v) } : typeof v === 'object' && 'date' in v ? { date: v.date } : typeof v === 'object' && 'formula' in v ? { formula: v.formula, value: enc(v.value) } : v;
  const mine = Object.fromEntries(Object.entries(E.workbookTables(js42.model)).map(([k, rows]) => [k, rows.map(r => r.map(enc))]));
  const ref = JSON.parse(py(`import json,datetime as dt,demo\nm=json.load(open('output/ledger.json'))\ndef enc(v):\n if isinstance(v,dt.date):return {'date':v.isoformat()}\n if isinstance(v,dict):return {'formula':v['formula'],'value':enc(v['value'])}\n if isinstance(v,float):return {'float':repr(v)}\n return v\nt=demo.workbook_tables(m)\nprint(json.dumps({k:[[enc(v) for v in row] for row in rows] for k,rows in t.items()}))`));
  const sheets = Object.keys(ref);
  const per = sheets.map(s => [s, deepEq(mine[s], ref[s]), ref[s].length]);
  check('E. workbook_tables cells (5 sheets: ' + per.map(([s, ok, n]) => `${s} ${n} rows ${ok ? '=' : '≠'}`).join(', ') + ')', per.every(x => x[1]) && deepEq(Object.keys(mine).sort(), sheets.sort()));
}
// F. Python checker accepts the browser-built folder (seed 42 and seed 17)
for (const s of [42, 17]) {
  const b = s === 42 ? js42 : await E.build(templates, s); const out = path.join(tmpRoot, 'js-seed-' + s); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'dirty-input.xlsx'), b.dirty); fs.writeFileSync(path.join(out, 'ledger.json'), b.ledger); fs.writeFileSync(path.join(out, 'cleaned-bills.xlsx'), b.cleaned);
  const r = spawnSync('python3', ['-B', 'demo.py', 'check', '--out', out, '--no-repeat'], { cwd: REPO, encoding: 'utf-8' });
  const last = (r.stdout.trim().split('\n').pop() || '') + (r.stderr.trim() ? ' | ' + r.stderr.trim().split('\n').pop() : '');
  check(`F. python3 demo.py check --out <browser-built seed ${s}> --no-repeat → exit 0`, r.status === 0, last);
}
// G. negative control: a browser-built workbook with one Bills row removed must be rejected by the checker
{
  const out = path.join(tmpRoot, 'js-broken'); fs.mkdirSync(out, { recursive: true });
  const parts = await E.readZip(js42.cleaned); const sp = E.sheetPaths(parts); const p = sp['Bills'];
  const before = new TextDecoder().decode(parts[p]); const xml = before.replace(/<(?:\w+:)?row r="5"[^>]*>[\s\S]*?<\/(?:\w+:)?row>/, ''); if (xml === before) throw new Error('negative control: mutation did not change the sheet XML'); parts[p] = new TextEncoder().encode(xml);
  fs.writeFileSync(path.join(out, 'dirty-input.xlsx'), js42.dirty); fs.writeFileSync(path.join(out, 'ledger.json'), js42.ledger); fs.writeFileSync(path.join(out, 'cleaned-bills.xlsx'), E.writeZip(parts));
  const r = spawnSync('python3', ['-B', 'demo.py', 'check', '--out', out, '--no-repeat'], { cwd: REPO, encoding: 'utf-8' });
  check('G. negative control: Bills row 5 removed from browser-built workbook → checker exit 1 with "Bills: row count"', r.status === 1 && /Bills: row count/.test(r.stdout), r.stdout.trim().split('\n').pop());
}
// H. Python reads JS-built workbooks cell-for-cell equal to Python-built ones (inputs and outputs)
{
  const out = path.join(tmpRoot, 'js-seed-42');
  const same = py(`import sys,xlsx_io as x\nprint(x.read(sys.argv[1]+'/dirty-input.xlsx')==x.read('output/dirty-input.xlsx'), x.read(sys.argv[1]+'/cleaned-bills.xlsx')==x.read('output/cleaned-bills.xlsx'))`, out).trim();
  check('H. xlsx_io.read(JS-built) == xlsx_io.read(Python-built) for dirty-input and cleaned-bills', same === 'True True', same);
}
} catch (e) { results.push(['FAIL', 'harness step threw', String(e.stack || e)]); failed++; }
console.log(`bills-engine parity · ${new Date().toISOString()} · node ${process.version} · repo ${REPO}`);
for (const [st, name, d] of results) console.log(`${st}  ${name}${d ? '  · ' + d : ''}`);
console.log(failed ? `RESULT: ${failed} FAILED` : 'RESULT: ALL PASS');
console.log('tmp:', tmpRoot);
process.exit(failed ? 1 : 0);
