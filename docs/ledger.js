/* Approved ledger connected to the existing billing engine and persisted decisions. */
(() => {
const $ = selector => document.querySelector(selector);
let records = [];
function syncRecords() {
  const model = window.BillBench.model();
  records = model.records.map(record => ({ ...record,
      raw: [...record.raw], reasons: [...record.reasons],
      excluded: record.status === 'excluded' }));
}
let sheet = 'all';
let selected;
let hoveredRow;
function paintLedger() {
  const body = $('#ledger-body');
  const scroll = document.querySelector('.ledger-scroll');
  const table = body.closest('table');
  let offset = table.tHead.getBoundingClientRect().height;
  const stops = [`var(--surface) 0px ${offset}px`];
  for (const row of body.rows) {
    let tone = '--surface';
    if (row.classList.contains('needs-review')) tone = row.querySelector('.danger') ? '--danger-soft' : '--warning-soft';
    if (row.classList.contains('selected-row')) tone = '--selection';
    if (row === hoveredRow) tone = '--soft';
    const bottom = offset + row.getBoundingClientRect().height;
    stops.push(`var(${tone}) ${offset}px ${bottom}px`);
    offset = bottom;
  }
  scroll.style.backgroundImage = `linear-gradient(to bottom,${stops.join(',')})`;
  scroll.style.backgroundSize = `${table.scrollWidth}px ${offset}px`;
}
const money = cents => cents === null ? 'Unknown' : (cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function readableReason(reason) {
  if (reason === 'unmapped merchant') return 'Needs category';
  if (reason.startsWith('high amount')) return 'Large amount';
  if (reason.startsWith('exact duplicate')) return 'Exact duplicate';
  if (reason.startsWith('possible duplicate')) return 'Possible duplicate';
  if (reason.startsWith('ambiguous date')) return 'Date order unclear';
  if (reason.startsWith('invalid amount')) return 'Cannot read amount';
  if (reason === 'category edited by reviewer') return 'Category edited';
  return reason[0].toUpperCase() + reason.slice(1);
}
function render() {
  const search = $('#find').value.trim().toLowerCase();
  const reason = $('#reason').value;
  const rows = records.filter(record => (sheet === 'all' || sheet === 'excluded' && record.excluded || !record.excluded && record.status === sheet) && record.merchant.toLowerCase().includes(search) && (reason === 'all' || reason === 'review' && record.reasons.length || reason === 'category' && record.category === 'Uncategorised' || reason === 'missing' && record.reasons.some(item => item.startsWith('missing'))));
  $('#visible-count').textContent = `${rows.length} rows`;
  $('#review-count').textContent = `${records.filter(record => record.reasons.length && !record.excluded && !record.decided).length} rows need attention`;
  const firstProblemIndex = records.findIndex(record => record.reasons.length && !record.excluded && !record.decided);
  const firstProblem = records[firstProblemIndex];
  $('#review-first').disabled = !firstProblem;
  if (firstProblem) {
    const reason = firstProblem.reasons.includes('missing date') ? 'Missing date' : readableReason(firstProblem.reasons[0]);
    const title=document.createElement('span');
    title.textContent='Review ledger row ' + (firstProblemIndex + 1) + ' · ' + reason;
    const source=document.createElement('small');
    source.className='next-review-source'; source.textContent=firstProblem.source_sheet + ' · source row ' + firstProblem.source_row;
    $('#review-first').replaceChildren(title,source);
    $('#review-first').dataset.actionName=title.textContent + ', ' + source.textContent;
    document.querySelector('.review-toolbar p').textContent='';
    document.querySelector('.review-toolbar p').hidden=true;
  } else {
    $('#review-first').textContent = 'Review complete';
    document.querySelector('.review-toolbar p').hidden=false;
    document.querySelector('.review-toolbar p').textContent = 'All flagged rows have a review decision.';
  }
  $('#ledger-body').replaceChildren();
  rows.forEach(record => {
    const tr = document.createElement('tr');
    tr.dataset.id = record.id;
    if (record.reasons.length) tr.className = 'needs-review';
    const cells = [
      [records.indexOf(record) + 1, 'row-no'], [record.merchant, 'merchant-col'], [record.invoice, 'invoice-col'],
      [record.date || 'Missing', 'date-col'], [record.category, 'category-col'], [money(record.cents), 'amount-col'],
      [record.excluded ? 'Excluded' : record.reasons.includes('missing date') ? 'Missing date' : record.reasons.length ? readableReason(record.reasons[0]) : 'Ready', ''],
      [`${record.source_sheet.replace('Export ', '')}:${record.source_row}`, 'source-col'],
      [`${record.source_file} · ${record.source_sheet}`, 'source-file-col'],
      [record.raw[record.headers.findIndex(header=>/date|billed on/i.test(header))] || 'Missing', 'original-date-col'],
      [record.raw[record.headers.findIndex(header=>/amount/i.test(header))] || 'Missing', 'original-amount-col'],
    ];
    for (const [text, className] of cells) {
      const td = document.createElement('td');
      td.className = className;
      td.textContent = text;
      tr.append(td);
    }
    {
      const mark = document.createElement('span');
      const label = tr.children[6].textContent;
      mark.className = 'badge' + (/Missing|Cannot read/.test(label) ? ' danger' : record.reasons.length && !record.excluded ? ' warning' : '');
      mark.textContent = tr.children[6].textContent;
      tr.children[6].replaceChildren(mark);
    }
    tr.tabIndex = 0;
    tr.setAttribute('aria-label', `Review ${record.invoice}, ${record.merchant}`);
    tr.addEventListener('click', () => review(record));
    tr.addEventListener('keydown', event => { if (event.key === 'Enter') review(record); });
    $('#ledger-body').append(tr);
  });
  const model = window.BillBench.model();
  const rec = model.reconciliation;
  const tiles = document.querySelectorAll('.tieout > div');
  const groups = [[records.length, rec.known_input_cents], [rec.counts.clean, rec.cents.clean], [rec.counts.duplicate, rec.cents.duplicate], [rec.counts.unparseable, rec.cents.unparseable]];
  groups.forEach(([count, cents], index) => { tiles[index].querySelector('strong').textContent = count; tiles[index].querySelector('p').textContent = `CAD ${money(cents)}${index === 0 || index === 3 ? ' known' : ''}`; });
  document.querySelector('.reconcile-heading .badge').textContent = `${records.length} rows reconciled`;
  document.querySelector('.unknown').textContent = `${rec.unknown_amount_rows} rows have unknown amounts. Known amounts add up, with those rows disclosed separately.`;
  document.querySelector('.duplicates').style.flex = rec.counts.duplicate;
  document.querySelector('.unreadable').style.flex = rec.counts.unparseable;
  for (const status of ['all', 'duplicate', 'unparseable']) document.querySelector(`[data-sheet="${status}"] span`).textContent = status === 'all' ? records.length : rec.counts[status];
  document.querySelector('.row-accounting').setAttribute('aria-label', `${records.length} rows: ${rec.counts.clean} kept, ${rec.counts.duplicate} duplicates, ${rec.counts.unparseable} unreadable, ${rec.counts.excluded} exclusions`);
  const kept = records.filter(record=>record.status==='clean'&&!record.excluded);
  const excluded = records.filter(record=>record.excluded);
  const keptTile = document.querySelectorAll('.tieout > div')[1];
  keptTile.querySelector('strong').textContent = kept.length;
  keptTile.querySelector('p').textContent = `CAD ${money(kept.reduce((sum,record)=>sum+(record.cents||0),0))}`;
  document.querySelector('[data-sheet="clean"] span').textContent = kept.length;
  $('#excluded-tile').hidden = !excluded.length;
  $('#excluded-tile strong').textContent = excluded.length;
  $('#excluded-tile p').textContent = `CAD ${money(excluded.reduce((sum,record)=>sum+(record.cents||0),0))}`;
  document.querySelector('[data-sheet="excluded"]').hidden = !excluded.length;
  document.querySelector('[data-sheet="excluded"] span').textContent = excluded.length;
  document.querySelector('.kept').style.flex = kept.length;
  document.querySelector('.excluded-part').style.flex = excluded.length;
  document.querySelector('.excluded-part').hidden = !excluded.length;
  ui.fade($('#ledger-body'));
  ui.enhanceTables(document.querySelector('.ledger'));
}
function review(record) {
  selected = record;
  const rowNumber = records.indexOf(record) + 1;
  $('#review-title').textContent = 'Review ledger row ' + rowNumber;
  document.querySelectorAll('.selected-row').forEach(row => row.classList.remove('selected-row'));
  const row = [...document.querySelectorAll('#ledger-body tr')].find(row => row.dataset.id === record.id);
  row?.classList.add('selected-row');
  row?.scrollIntoView({ block: 'nearest' });
  $('#review-source').textContent = 'Source: ' + record.source_file + ' · ' + record.source_sheet + ', row ' + record.source_row;
  $('#source-comparison').replaceChildren();
  const dateIssue=record.reasons.includes('missing date') ? 'Needs a date' : record.reasons.some(r=>r==='invalid date'||r.startsWith('ambiguous date')) ? 'Check date' : '';
  const amountIssue=record.reasons.includes('missing amount') ? 'Needs an amount' : record.reasons.some(r=>r.startsWith('invalid amount')) ? 'Check amount' : record.reasons.some(r=>r.startsWith('high amount')) ? 'Check large amount' : '';
  const fields = [
    ['Invoice', record.raw[0], record.invoice, ''],
    ['Merchant', record.raw[1], record.merchant, record.reasons.includes('missing merchant')?'Needs a merchant':''],
    ['Date', record.raw[2], record.date || 'Missing', dateIssue],
    ['Amount, CAD', record.raw[3], money(record.cents), amountIssue],
    ['Category', 'Not in source', record.category, record.reasons.includes('unmapped merchant')?'Needs a category':'']
  ];
  for (const [label, raw, reviewed, issue] of fields) {
    const original = raw === null || raw === undefined || String(raw).trim() === '' ? 'Missing' : String(raw);
    const tr=document.createElement('tr'); tr.dataset.field=label;
    const heading=document.createElement('th'); heading.scope='row'; heading.textContent=label; tr.append(heading);
    const source=document.createElement('td'); source.textContent=original; tr.append(source);
    const value=document.createElement('td');
    if (issue) {
      tr.className='problem-field';
      const mark=document.createElement('strong'); mark.textContent=reviewed;
      const hint=document.createElement('small'); hint.textContent=issue;
      value.append(mark,hint);
    } else if (original !== String(reviewed)) {
      const mark=document.createElement('span'); mark.className='normalised-value'; mark.textContent=reviewed;
      value.append(mark); value.className='changed';
    } else value.textContent=reviewed;
    tr.append(value); $('#source-comparison').append(tr);
  }
  const reasons=record.reasons.filter(reason=>!reason.endsWith('by reviewer')).sort((a,b)=>(a==='missing date'?-1:b==='missing date'?1:0)).map(readableReason);
  const reasonText=reasons.length ? reasons.map((reason,index)=>index ? reason[0].toLowerCase()+reason.slice(1) : reason).join(' and ') : record.category !== 'Uncategorised' ? 'Category edited' : 'No outstanding flags';
  const destination=record.status === 'clean' ? 'in Bills' : 'out of Bills';
  $('#review-reasons').textContent=record.decided
    ? reasonText + ': reviewed; this row stays ' + destination + ' with its original cells.'
    : reasonText + ': confirm to keep this row ' + destination + ' with its original cells.';
  const id=record.id;
  window.BillBench.mountReviewActions($('#shared-review-actions'),id,{
    refresh: () => { window.BillBench.render(); review(records.find(item=>item.id===id)); $('#shared-review-actions button')?.focus({preventScroll:true}); },
    complete: () => { $('#review-dialog').close(); window.BillBench.render(); }
  });
  $('#full-review').href = '#/review?i=' + encodeURIComponent(record.id);
  if (!$('#review-dialog').open) $('#review-dialog').showModal();
}
$('#review-first').addEventListener('click', () => {
  const first = records.find(record => record.reasons.length && !record.excluded && !record.decided);
  if (!first) return;
  $('#find').value = '';
  $('#reason').value = 'all';
  document.querySelector('[data-sheet="all"]').click();
  review(first);
});
$('#workbook-info').addEventListener('click',()=>$('#workbook-dialog').showModal());
$('#find').addEventListener('input', render);
$('#reason').addEventListener('change', render);
document.querySelectorAll('[data-sheet]').forEach(button => button.addEventListener('click', () => {
  sheet = button.dataset.sheet;
  document.querySelectorAll('[data-sheet]').forEach(item => item.removeAttribute('aria-current'));
  button.setAttribute('aria-current', 'page');
  render();
}));
const ledgerBody = $('#ledger-body');
new MutationObserver(paintLedger).observe(ledgerBody,{childList:true,subtree:true,attributes:true,attributeFilter:['class']});
new ResizeObserver(paintLedger).observe(document.querySelector('.ledger-scroll'));
ledgerBody.addEventListener('pointerover',event=>{
  const row=event.target.closest('tr');
  if(row===hoveredRow)return;
  hoveredRow=row;
  paintLedger();
});
ledgerBody.addEventListener('pointerleave',()=>{hoveredRow=null;paintLedger();});


function updateWorkspace() {
  const view = location.hash.replace(/^#\/?/, '').split('?')[0];
  const overview = !!window.BillBench.state.rows && (!location.hash || view === 'overview');
  $('#ledger-main').hidden = !overview;
  $('#legacy-workspace').hidden = overview;
  if (overview) { syncRecords(); render(); paintLedger(); }
  $('.file-chip').textContent = window.BillBench.state.source?.kind === 'file' ? window.BillBench.state.source.name : 'dirty-input.xlsx';
  document.querySelector('header .badge').textContent = window.BillBench.state.source?.kind === 'file' ? 'Local workbook' : 'Sample workbook';
  if (window.BillBench.state.rows) {
    const model = window.BillBench.model();
    document.querySelector('#workbook-summary').textContent = `${model.records.length} rows from ${window.BillBench.state.source.kind === 'sample' ? 'the synthetic sample workbook' : window.BillBench.state.source.name}. ${model.reconciliation.unknown_amount_rows} source rows have amounts that cannot be read. Merchant names and invoice numbers follow the engine and original source cells.`;
  }
  document.documentElement.dataset.ready = 'true';
}
window.addEventListener('bill-render', updateWorkspace);
$('#workbook-tools').addEventListener('click', event => { if (event.target.closest('a')) $('#workbook-dialog').close(); });
$('#full-review').addEventListener('click', () => $('#review-dialog').close());

})();
