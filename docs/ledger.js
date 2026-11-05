/* Approved ledger connected to the existing billing engine and persisted decisions. */
(() => {
const $ = selector => document.querySelector(selector);
let records = [];
function syncRecords() {
  const model = window.BillBench.model();
  records = model.records.map(record => ({ ...record,
      raw: [...record.raw], reasons: record.reasons.filter(reason => !record.decided || record.decided === 'category' || reason !== 'unmapped merchant'),
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
    const detail = document.createElement('span');
    detail.textContent = reason;
    $('#review-first').replaceChildren(document.createTextNode(`Review row ${firstProblemIndex + 1} `), detail);
    $('#review-first').dataset.actionName = reason === 'Missing date' ? `Review row ${firstProblemIndex + 1} for a missing date` : `Review row ${firstProblemIndex + 1}`;
    document.querySelector('.review-toolbar p').textContent = `The next problem is in row ${firstProblemIndex + 1}.`;
  } else {
    $('#review-first').textContent = 'Review complete';
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
  $('#review-title').textContent = `Review row ${rowNumber}`;
  document.querySelectorAll('.selected-row').forEach(row => row.classList.remove('selected-row'));
  const row = [...document.querySelectorAll('#ledger-body tr')].find(row => row.dataset.id === record.id);
  row?.classList.add('selected-row');
  row?.scrollIntoView({ block: 'nearest' });
  $('#review-source').textContent = `${record.source_file}, ${record.source_sheet}, row ${record.source_row}`;
  $('#original-values').replaceChildren();
  record.headers.forEach((name, index) => {
    const row = document.createElement('div');
    const label = document.createElement('span');
    const value = document.createElement('span');
    label.textContent = name;
    const original = record.raw[index];
    value.textContent = original === null || original === undefined || String(original).trim() === ''
      ? /date|billed on/i.test(name) ? 'Missing' : 'Empty in source file'
      : original;
    row.append(label, value);
    $('#original-values').append(row);
  });
  $('#review-reasons').textContent = record.reasons.length ? record.reasons.map(readableReason).join('. ') : 'This row has no review flags.';
  $('#set-category').value = record.category;
  $('#exclude').disabled = record.status !== 'clean' || record.excluded;
  const exclusionReason=record.excluded?'This row has already been excluded.':record.status==='duplicate'?'This row is already outside kept rows because it is a duplicate.':record.status!=='clean'?'This row is already outside kept rows because its date or amount is unreadable.':'';
  $('#exclude-reason').textContent=exclusionReason;
  $('#exclude-reason').hidden=!exclusionReason;
  $('#undo-review').hidden = !record.decided;
  $('#set-category').dispatchEvent(new Event('ui-sync'));
  const title=document.createElement('h4');title.textContent='Source row preview';
  const fields=document.createElement('dl');fields.className='preview-fields';
  for(const [name,text] of [['Merchant',record.merchant],['Invoice',record.invoice||'Missing'],['Date',record.date||'Missing'],['Source',`${record.source_sheet} · row ${record.source_row}`],['Amount',`CAD ${money(record.cents)}`]]){
    const label=document.createElement('dt');label.textContent=name;
    const value=document.createElement('dd');value.textContent=text;
    fields.append(label,value);
  }
  const caption=document.createElement('figcaption');
  caption.textContent='Generated from this source row and its reviewed fields';
  $('#bill-thumbnail').replaceChildren(title,fields,caption);
  $('#full-review').href = `#/review?i=${encodeURIComponent(record.id)}`;
  $('#review-dialog').showModal();
}
$('#review-first').addEventListener('click', () => {
  const first = records.find(record => record.reasons.length && !record.excluded && !record.decided);
  if (!first) return;
  $('#find').value = '';
  $('#reason').value = 'all';
  document.querySelector('[data-sheet="all"]').click();
  review(first);
});
$('#apply-category').addEventListener('click', () => {
  window.BillBench.decide(selected.id, 'category', { after: $('#set-category').value });
  selected.category = $('#set-category').value;
  selected.reasons = selected.reasons.filter(reason => reason !== 'unmapped merchant');
  if (selected.category === 'Uncategorised') selected.reasons.unshift('unmapped merchant');
  $('#ledger-status').textContent = `Category for ${selected.invoice} set to ${selected.category} in this workbook. ${selected.reasons.length ? selected.reasons.map(readableReason).join('. ') + '.' : 'No review flags remain.'}`;
  $('#review-dialog').close();
  window.BillBench.render();
});
$('#exclude').addEventListener('click',()=>{
  window.BillBench.decide(selected.id, 'exclude');
  $('#ledger-status').textContent=`${selected.invoice} excluded from kept rows. The original source cells remain available.`;
  $('#review-dialog').close();
  window.BillBench.render();
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
$('#undo-review').addEventListener('click', () => {
  const decision = window.BillBench.state.decisions.filter(item => item.rowId === selected.id && !item.undoneBy && item.action !== 'undo').at(-1);
  if (decision) window.BillBench.undoDecision(decision.id);
  $('#review-dialog').close();
  window.BillBench.render();
});

})();
