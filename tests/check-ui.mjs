import assert from 'node:assert/strict';
import {browserPage} from './browser.mjs';
const page=await browserPage(process.argv[2] || 'http://127.0.0.1:8765/bill-bench/');
const e=page.evaluate;
try {
  await page.waitFor('!!window.BillBench?.state.rows');
  const before=await e("BillBench.runChecks();window.beforeCheck=BillBench.state.checks;({count:document.querySelector('#review-count').textContent,raw:BillBench.model().records[5].raw,id:BillBench.model().records[5].id})");
  await e("document.querySelector('#review-first').click()");
  assert.equal(await e("document.querySelector('#review-title').textContent"),'Review ledger row 6');
  assert.match(await e("document.querySelector('#review-source').textContent"),/Export A, row 10/);
  assert.equal(await e("document.querySelector('#bill-thumbnail')"),null);
  assert.match(await e("document.querySelector('#review-export-note').textContent"),/outside Bills.*Needs review/);
  await e("[...document.querySelectorAll('#shared-review-actions button')].find(b=>b.textContent==='Set category ▾').click()");
  assert.equal(await e("document.querySelector('#review-dialog').open"),true,'category picker does not submit the review form');
  await e("document.querySelector('#shared-review-actions select[aria-label=\"Category\"]').value='Software';[...document.querySelectorAll('#shared-review-actions button')].find(b=>b.textContent==='Save category').click()");
  assert.equal(await e("document.querySelector('#review-count').textContent"),before.count,'category keeps attention count');
  assert.equal(await e("document.querySelector('#review-dialog').open"),true,'category keeps review open');
  assert.equal(await e("BillBench.model().records[5].decided"),null);
  assert.match(await e("document.querySelector('#review-reasons').textContent"),/Missing date/);
  assert.equal(await e("BillBench.state.checks===window.beforeCheck"),false,'previous checks invalidated');
  assert.deepEqual(await e("BillBench.model().records[5].raw"),before.raw,'source immutable');
  assert.match(await e("document.querySelector('#source-comparison tr:last-child .changed').textContent"),/Software/);
  await e("[...document.querySelectorAll('#shared-review-actions button')].find(b=>b.textContent==='Confirm review').click()");
  assert.equal(await e("BillBench.model().records[5].decided"),'confirm');
  assert.equal(await e("BillBench.model().records[5].status"),'unparseable','confirmation does not make unreadable row a bill');
  assert.equal(await e("document.querySelector('#review-dialog').open"),false);
  await e("document.querySelector('#ledger-body tr[data-id=\""+before.id+"\"]').click();[...document.querySelectorAll('#shared-review-actions button')].find(b=>b.textContent==='Undo review').click()");
  assert.equal(await e("BillBench.model().records[5].decided"),null);
  assert.equal(await e("BillBench.model().records[5].category"),'Software','undo confirmation retains category');
  assert.equal(await e("document.querySelector('#review-count').textContent"),before.count);
  await e("document.querySelector('#review-dialog').close();BillBench.runChecks();window.checkBeforeRule=BillBench.state.checks;location.hash='#/rules'");
  await page.waitFor("document.querySelector('#main h1')?.textContent==='Rules & thresholds'");
  await e("document.querySelector('input[aria-label=\"High-amount threshold in CAD\"]').value='1500';[...document.querySelectorAll('.rule-settings button')].find(b=>b.textContent==='Set').click();[...document.querySelectorAll('.pending button')].find(b=>b.textContent==='Apply changes').click()");
  assert.equal(await e("BillBench.state.checks"),null,'rule application invalidates checks');
  await e("document.querySelector('#direct-export').click()");
  await page.waitFor("document.querySelector('#main h1')?.textContent==='Export'");
  assert.ok(await e("BillBench.state.checks.items.every(c=>c.ok)"),'current export checks pass');
  assert.equal(await e("BillBench.state.checks.reviewChanges"),2,'category and undo audit; undone confirmation is omitted');
  assert.match(await e("document.querySelector('.export-checks').textContent"),/Current state: 2 review changes/);
  const workbook=await e("(async()=>{const b=await BillBench.exportWorkbook();const w=BillsEngine.parseWorkbook(await BillsEngine.readZip(b));return {sheets:Object.keys(w),text:JSON.stringify(w)};})()");
  assert.equal(workbook.sheets.length,5);
  assert.match(workbook.text,/Software/);
  assert.match(workbook.text,/missing date/);
  assert.match(workbook.text,/reviewer undo/);
  await e("document.querySelector('#direct-import').click()");
  await page.waitFor("!!document.querySelector('input[type=\"file\"]')");
  // A real local file goes through the public import control; no upload or download.
  await e("(async()=>{const csv='Invoice,Merchant,Date,Amount\\nA,Staples,2025-01-01,100\\nA,Staples,2025-01-01,100\\nB,Staples,2025-01-02,25.50\\nC,Staples,2025-01-03,wat\\n';const input=document.querySelector('input[type=\"file\"]');const dt=new DataTransfer();dt.items.add(new File([csv],'four-rows.csv',{type:'text/csv'}));input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()");
  await page.waitFor("BillBench.state.source?.name==='four-rows.csv'");
  assert.deepEqual(await e("BillBench.model().reconciliation.counts"),{clean:2,duplicate:1,unparseable:1,excluded:0});
  // A category-only issue still needs an explicit completion decision.
  await e("(async()=>{await BillBench.loadSample(42);location.hash='#/overview';BillBench.render();})()");
  const categoryOnly=await e("BillBench.model().records.find(r=>r.reasons.length===1&&r.reasons[0]==='unmapped merchant')?.id");
  assert.ok(categoryOnly);
  await e("BillBench.decide("+JSON.stringify(categoryOnly)+",'category',{after:'Other'});BillBench.render()");
  assert.equal(await e("BillBench.model().byId["+JSON.stringify(categoryOnly)+"].decided"),null);
  assert.ok(await e("BillBench.model().flagged.some(r=>r.id==="+JSON.stringify(categoryOnly)+")"));
  await e("document.querySelector('#ledger-body tr[data-id=\""+categoryOnly+"\"]').click();[...document.querySelectorAll('#shared-review-actions button')].find(b=>b.textContent==='Undo category edit').click()");
  assert.equal(await e("BillBench.model().byId["+JSON.stringify(categoryOnly)+"].category"),'Uncategorised');
  assert.match(await e("document.querySelector('#review-reasons').textContent"),/Needs category/);
  await e("document.querySelector('#review-dialog').close()");
  for(const [w,h] of [[1230,690],[1920,1080],[390,844]]) {
    await page.size(w,h);
    assert.ok(await e("document.documentElement.scrollWidth <= innerWidth"),'page fits '+w);
    assert.ok(await e("document.querySelector('#direct-import').getBoundingClientRect().width>0"),'direct import visible '+w);
    assert.ok(await e("document.querySelector('#direct-export').getBoundingClientRect().width>0"),'direct export visible '+w);
  }
  await e("document.querySelector('#review-first').click()");
  assert.equal(await e("getComputedStyle(document.querySelector('.source-comparison')).display"),'table','phone comparison stays compact');
  assert.ok(await e("[...document.querySelectorAll('#shared-review-actions button')].find(b=>b.textContent==='Confirm review').getBoundingClientRect().bottom < innerHeight"),'phone review completion is visible');
  await e("document.querySelector('#review-dialog').close()");
  assert.deepEqual(page.errors,[]);
  console.log('PASS: category vs completion; confirmation/undo; source comparison; current checks after rules and decisions; 5-sheet edited export; real CSV import; 3 viewports.');
} finally {await page.close();}

