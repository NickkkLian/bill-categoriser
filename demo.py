"""Deterministic synthetic bill cleaning. Python standard library only."""
import argparse
import os
import copy
import datetime as dt
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
import random
import re
import subprocess
import sys
import tempfile
import contextlib
import shutil
import uuid
import urllib.error
import llm  # provider-agnostic LLM calls: anthropic (default), openai, gemini, openai-compatible
import xlsx_io as xlsx

ROOT=Path(__file__).resolve().parent
HEADERS=[['Invoice','Vendor','Date','Amount'],['Bill ID','Merchant name','Invoice date','Total CAD'],['Reference','Payee','Billed on','Gross amount']]
SHEETS=['Export A','Export B','Export C']
MERCHANTS=[('Demo Supply 01','Supplies'),('Demo Utility 02','Utilities'),('Demo Software 03','Software'),('Demo Lease 04','Rent'),('Demo Carrier 05','Transport'),('Demo Other 06','Uncategorised')]
ALIASES={re.sub(r'[^a-z0-9]','',m.lower()):m for m,c in MERCHANTS}
CATEGORY=dict(MERCHANTS)
DEFAULT_HIGH_CENTS=250000
LLM_CACHE=ROOT/'docs'/'llm-cache.json'   # served by the web version too; keyed by normalised merchant name
CATEGORIES=sorted({c for _,c in MERCHANTS if c!='Uncategorised'})
KEYWORDS=[(re.compile(r'supply|supplies|office|paper|stationer',re.I),'Supplies'),(re.compile(r'utility|hydro|electric|water|gas|power|energy|telecom|fibre|fiber|internet',re.I),'Utilities'),(re.compile(r'software|saas|cloud|app|hosting|licen',re.I),'Software'),(re.compile(r'lease|rent|landlord|property|realty',re.I),'Rent'),(re.compile(r'carrier|freight|courier|shipping|transport|logistic|delivery|haul',re.I),'Transport')]
def norm(m):return re.sub(r'[^a-z0-9]','',m.lower())
def keyword_guess(m):
    for rx,c in KEYWORDS:
        if rx.search(m):return c
    return None
def load_cache():
    if not LLM_CACHE.exists():return {'model':None,'entries':{}}
    return json.loads(LLM_CACHE.read_text(encoding='utf-8'))
def validate_cache(cache):
    """Cache shape: {"model": str, "generated": ISO date, "entries": {norm(merchant): {"merchant","category"|null,"confidence","reason"}}}."""
    assert isinstance(cache.get('entries'),dict),'llm-cache: entries must be an object'
    for k,e in cache['entries'].items():
        assert k==norm(e.get('merchant','')),'llm-cache: key does not match normalised merchant '+k
        assert e.get('category') is None or e['category'] in CATEGORIES,'llm-cache: category outside the allowed set for '+k
        assert e.get('confidence') is None or 0<=float(e['confidence'])<=1,'llm-cache: confidence outside 0..1 for '+k
    if cache['entries']:assert cache.get('model') and cache.get('generated') and cache.get('provider') in llm.PROVIDERS,'llm-cache: provider, model and generated date required'
BATCH=12  # merchants per call: each answer carries a merchant, a category, a confidence and a short reason, and
          # thirty of them overran the 2048-token reply budget on 2026-09-22 — the array was cut off mid-string
def ask_llm(merchants):
    """One call per batch of merchants to whichever provider LLM_PROVIDER names (see llm.py).
    Returns ({norm: entry}, model, provider). Any failure raises; callers fall back to Uncategorised."""
    cfg=llm.config_from_env()
    system=('You classify small-business bill merchants into exactly one of these categories: '+', '.join(CATEGORIES)+'. If the name gives no reliable signal, use null. Reply with JSON only: an array of {"merchant": string, "category": string|null, "confidence": number 0-1, "reason": short string}. Never invent facts about the merchant.')
    out={};model=None
    for i in range(0,len(merchants),BATCH):
        chunk=merchants[i:i+BATCH]
        text,model=llm.complete(cfg,system,json.dumps([{'merchant':m} for m in chunk]))
        for x in llm.extract_json(text,'array'):
            if not isinstance(x,dict) or not isinstance(x.get('merchant'),str):continue
            cat=x.get('category') if x.get('category') in CATEGORIES else None
            conf=x.get('confidence');conf=float(conf) if isinstance(conf,(int,float)) and 0<=conf<=1 else None
            out[norm(x['merchant'])]={'merchant':x['merchant'],'category':cat,'confidence':conf,'reason':str(x.get('reason',''))[:140]}
    return out,model,cfg['provider']
def llm_fill(merchants,cache):
    """Fill cache entries for merchants not yet cached. Returns (added, error)."""
    missing=[m for m in merchants if norm(m) not in cache['entries']]
    if not missing:return 0,None
    try:
        got,model,provider=ask_llm(missing)
    except (llm.ConfigError,llm.ProviderError,urllib.error.URLError,ValueError,OSError,KeyError) as e:
        return 0,f'{type(e).__name__}: {e}'
    for m in missing:
        e=got.get(norm(m)) or {'merchant':m,'category':None,'confidence':None,'reason':'no answer from the model'}
        e['merchant']=m;cache['entries'][norm(m)]=e
    cache['provider']=provider;cache['model']=model;cache['generated']=dt.date.today().isoformat()
    return len(missing),None
def save_cache(cache):
    validate_cache(cache);LLM_CACHE.parent.mkdir(parents=True,exist_ok=True)
    LLM_CACHE.write_text(json.dumps(cache,indent=2,ensure_ascii=True,sort_keys=True)+'\n',encoding='utf-8')
def llm_suggestions(model):
    """Suggestions for Uncategorised merchants from the cache. Advisory only: the ledger and workbook never change."""
    cache=load_cache();validate_cache(cache)
    names=sorted({r['merchant'] for r in model['records'] if r['category']=='Uncategorised'})
    return {'provider':cache.get('provider'),'model':cache.get('model'),'generated':cache.get('generated'),'suggestions':{m:cache['entries'].get(norm(m)) for m in names}}
def eval_llm(use_llm=False):
    """Score cached model output (and the keyword baseline) on eval/merchants.json. Exit 0 pass, 1 fail, 2 not run."""
    spec=json.loads((ROOT/'eval'/'merchants.json').read_text(encoding='utf-8'));items=spec['items'];cache=load_cache();validate_cache(cache)
    if use_llm:
        added,err=llm_fill([i['merchant'] for i in items],cache)
        if err:print('LLM call failed: '+err);return 2
        save_cache(cache);print(f'LLM cache: {added} new entries ({cache["provider"]} · {cache["model"]}, {cache["generated"]})')
    base=sum(keyword_guess(i['merchant'])==i['expected'] for i in items)
    # The split is computed, not asserted. It used to read "by construction: 20 keyword names + 10 that need
    # inference", which implies the baseline gets all twenty — it gets nineteen. One keyword name is written
    # "Leasing" and the rule looks for "lease".
    cached=[i for i in items if norm(i['merchant']) in cache['entries']]
    bybase={k:(sum(1 for i in items if i['kind']==k and keyword_guess(i['merchant'])==i['expected']),sum(1 for i in items if i['kind']==k)) for k in ('keyword','inference')}
    print(f'keyword baseline: {base}/{len(items)} = {base/len(items):.0%} · keyword names {bybase["keyword"][0]}/{bybase["keyword"][1]} · inference names {bybase["inference"][0]}/{bybase["inference"][1]}')
    if len(cached)<len(items):
        print(f'NOT RUN: cached model output covers {len(cached)}/{len(items)} eval merchants. Populate with: ANTHROPIC_API_KEY=... python3 -B demo.py eval --llm  (or LLM_PROVIDER=openai|gemini|openai-compatible with LLM_MODEL and the key for that provider)');return 2
    hits=[i for i in items if cache['entries'][norm(i['merchant'])]['category']==i['expected']]
    by={k:(sum(1 for i in hits if i['kind']==k),sum(1 for i in items if i['kind']==k)) for k in ('keyword','inference')}
    acc=len(hits)/len(items)
    print(f'model {cache["model"]} ({cache["generated"]}): {len(hits)}/{len(items)} = {acc:.0%} · keyword names {by["keyword"][0]}/{by["keyword"][1]} · inference names {by["inference"][0]}/{by["inference"][1]}')
    for i in items:
        e=cache['entries'][norm(i['merchant'])]
        if e['category']!=i['expected']:print(f'  miss: {i["merchant"]!r} expected {i["expected"]} got {e["category"]} ({e.get("reason","")[:60]})')
    ok=acc>=spec['pass_threshold'];print(('EVAL PASS' if ok else 'EVAL FAIL')+f' (threshold {spec["pass_threshold"]:.0%})');return 0 if ok else 1

@contextlib.contextmanager
def scratch(prefix):
    path=ROOT/(prefix+uuid.uuid4().hex);path.mkdir()
    try:yield str(path)
    finally:
        resolved=path.resolve()
        if resolved.parent!=ROOT or not resolved.name.startswith(prefix):raise ValueError('unsafe scratch cleanup')
        shutil.rmtree(resolved)

def dump(p,v):
    p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((json.dumps(v,indent=2,ensure_ascii=True,sort_keys=True)+'\n').encode('utf-8'))
def threshold_cents(raw):
    try:value=Decimal(str(raw))
    except InvalidOperation:raise argparse.ArgumentTypeError('high threshold must be a CAD amount')
    if not value.is_finite():raise argparse.ArgumentTypeError('high threshold must be a finite CAD amount')
    cents=value*100
    if value<0 or cents!=cents.to_integral_value():raise argparse.ArgumentTypeError('high threshold must be non-negative with at most two decimals')
    return int(cents)
def threshold_label(cents):
    value=Decimal(cents)/100
    return f'{value:,.2f}'.rstrip('0').rstrip('.')
def money(raw):
    s=str(raw).strip()
    if not s:raise ValueError('missing amount')
    neg=s.startswith('(') and s.endswith(')')
    if neg:s=s[1:-1]
    s=re.sub(r'^(?:CAD\s*|\$)','',s).strip()
    if not re.fullmatch(r'-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{2})?',s):raise ValueError('invalid amount or unsupported currency')
    value=Decimal(s.replace(',',''))
    if neg and value<0:raise ValueError('conflicting signs')
    return int(value*100)*(-1 if neg else 1)
def date(raw):
    s=str(raw).strip()
    if not s:raise ValueError('missing date')
    if re.fullmatch(r'\d{1,2}/\d{1,2}/\d{4}',s):raise ValueError('ambiguous date: slash order unspecified')
    for fmt in ('%Y-%m-%d','%Y/%m/%d','%d-%b-%Y'):
        try:return dt.datetime.strptime(s,fmt).date().isoformat()
        except ValueError:pass
    raise ValueError('invalid date')
def generate(seed):
    rng=random.Random(seed);out=[]
    for i in range(120):
        m,c=MERCHANTS[i%6]
        vendor=[m,m.upper(),'  '+m.lower()+'  ',m.replace(' ','-')][i%4]
        day=dt.date(2025,i%12+1,rng.randint(1,27))
        ds=day.strftime(['%Y-%m-%d','%Y/%m/%d','%d-%b-%Y'][i%3])
        cents=rng.randint(1200,280000)*(-1 if i%19==0 else 1)
        amount=Decimal(cents)/100
        amt=[f'CAD {amount:,.2f}',f'${amount:,.2f}',f'{amount:.2f}'][i%3]
        if i==0:amt='(CAD 1,250.00)'
        if i in (5,17):ds=''
        if i in (8,29):amt=''
        if i==22:ds='2025-02-30'
        if i==24:amt='CAD 12,34.00'
        if i==31:ds='03/04/2025'
        if i==32:amt='USD 45.00'
        if i==35:vendor='=SYNTHETIC_FORMULA_TEXT()'
        if i==40:amt='CAD 0.00'
        out.append([f'SYN-{i+1:04d}',vendor,ds,amt])
    out += [copy.deepcopy(out[i]) for i in (1,12,44)]
    for i in (2,13):
        v=copy.deepcopy(out[i]);v[0]+='-COPY';v[1]=v[1].upper().strip();out.append(v)
    return {s:out[n*42:(n+1)*42] for n,s in enumerate(SHEETS)}
def read_input(path):
    workbook=xlsx.read(path);rows=[]
    for si,sheet in enumerate(SHEETS):
        if sheet not in workbook:raise ValueError('missing source sheet '+sheet)
        if workbook[sheet].get(4)!=HEADERS[si]:raise ValueError('unexpected headers '+sheet)
        for rn,vals in sorted(workbook[sheet].items()):
            if rn<5:continue
            vals=vals+[None]*(4-len(vals))
            if len(vals)!=4 or any(isinstance(v,dict) for v in vals):raise ValueError('input formula or unsupported columns')
            rows.append({'id':f'{si+1}:{rn}','raw':[str(v) if v is not None else '' for v in vals], 'source_file':path.name,'source_sheet':sheet,'source_row':rn,'headers':HEADERS[si]})
    return rows
def clean(rows,high_cents):
    records=[];changes=[];seen={};near={}
    for row in rows:
        invoice,raw_m,raw_d,raw_a=row['raw'];reasons=[]
        def change(field,before,after,rule):
            if before!=after:changes.append({'id':row['id'],'field':field,'before':before,'after':after,'rule':rule,'source_file':row['source_file'],'source_sheet':row['source_sheet'],'source_row':row['source_row']})
        for old,new in zip(row['headers'],['invoice','merchant','date','amount_cad']):change('header',old,new,'header alias map')
        invoice2=invoice.strip();change('invoice',invoice,invoice2,'trim surrounding whitespace')
        merchant=ALIASES.get(re.sub(r'[^a-z0-9]','',raw_m.lower()),raw_m.strip())
        change('merchant',raw_m,merchant,'synthetic merchant alias map')
        cat=CATEGORY.get(merchant,'Uncategorised');change('category','',cat,'exact merchant rule' if cat!='Uncategorised' else 'no rule; manual review')
        if cat=='Uncategorised':reasons.append('unmapped merchant')
        try:cents=money(raw_a);change('amount',raw_a,f'{Decimal(cents)/100:.2f}','CAD symbols, grouping and refund sign')
        except ValueError as e:cents=None;reasons.append(str(e))
        try:d=date(raw_d);change('date',raw_d,d,'explicit non-ambiguous date format')
        except ValueError as e:d=None;reasons.append(str(e))
        status='clean' if cents is not None and d is not None else 'unparseable';duplicate_of=None
        key=(invoice2,merchant,d,cents)
        if status=='clean':
            if key in seen:status='duplicate';duplicate_of=seen[key];reasons.append('exact duplicate of '+duplicate_of)
            else:
                seen[key]=row['id'];nk=(merchant,d,cents)
                if nk in near:reasons.append('possible duplicate of '+near[nk]+'; retained for review')
                else:near[nk]=row['id']
        if cents is not None and abs(cents)>=high_cents:reasons.append('high amount: absolute CAD >= '+threshold_label(high_cents))
        change('disposition','input',status,'partition; never discard a source row')
        records.append({**row,'invoice':invoice2,'merchant':merchant,'date':d,'cents':cents,'category':cat,'status':status,'duplicate_of':duplicate_of,'reasons':reasons})
    return {'records':records,'changes':changes,'reconciliation':reconcile(records)}
def reconcile(records):
    counts={s:sum(r['status']==s for r in records) for s in ('clean','duplicate','unparseable')}
    totals={s:sum(r['cents'] or 0 for r in records if r['status']==s) for s in counts}
    return {'count':len(records),'counts':counts,'cents':totals,'known_input_cents':sum(r['cents'] or 0 for r in records),'unknown_amount_rows':sum(r['cents'] is None for r in records)}
def formula(text,value):return {'formula':text,'value':round(value,2)}
def workbook_tables(model):
    rows=model['records'];bill=[r for r in rows if r['status']=='clean'];bad=[r for r in rows if r['reasons']];dups=[r for r in rows if r['status']=='duplicate']
    src=lambda r:[r['source_file'],r['source_sheet'],r['source_row']]
    amt=lambda r:None if r['cents'] is None else r['cents']/100
    dates=lambda r:dt.date.fromisoformat(r['date']) if r['date'] else None
    result={'Bills':[[r['id'],r['invoice'],dates(r),r['merchant'],r['category'],amt(r),r['raw'][1],*src(r),'; '.join(r['reasons'])] for r in bill],
    'Needs review':[[r['id'],r['status'],'; '.join(r['reasons']),r['invoice'],r['raw'][1],r['raw'][2],r['raw'][3],amt(r),*src(r)] for r in bad],
    'Duplicates':[[r['id'],r['duplicate_of'],r['invoice'],r['merchant'],dates(r),amt(r),*src(r)] for r in dups],
    'Change log':[[r['id'],r['field'],r['before'],r['after'],r['rule'],*src(r)] for r in model['changes']]}
    rec=model['reconciliation'];end=len(bill)+4;sumrows=[]
    sumrows.append(['Retained bills',formula(f"SUM('Bills'!F5:F{end})",rec['cents']['clean']/100),len(bill),'Includes possible duplicates; resolve review before posting.'])
    sumrows.append(['Exact duplicates excluded',formula(f"SUM('Duplicates'!F5:F{len(dups)+4})",rec['cents']['duplicate']/100),len(dups),'Excluded from Bills; original rows retained.'])
    sumrows.append(['Unparseable: known amounts',formula(f'SUMIFS(\'Needs review\'!H5:H{len(bad)+4},\'Needs review\'!B5:B{len(bad)+4},"unparseable")',rec['cents']['unparseable']/100),rec['counts']['unparseable'],'Not included in monthly totals.'])
    sumrows.append(['All known input amounts',rec['known_input_cents']/100,len(rows),'Independent source control, before duplicate exclusion.'])
    sumrows.append(['Reconciliation difference',formula('(ROUND(B5*100,0)+ROUND(B6*100,0)+ROUND(B7*100,0)-ROUND(B8*100,0))/100',0),None,'Exact cents; must equal zero. Missing amounts stay unknown.'])
    sumrows.append(['Unknown amounts',None,rec['unknown_amount_rows'],'Blank amounts are unknown, never treated as real zero.'])
    sumrows.append(['Review rows',None,len(bad),'Every flagged row, including duplicates.'])
    sumrows.append(['MONTHLY TOTALS',None,None,'Retained bills only; CAD.'])
    for mo in range(1,13):
        start=dt.date(2025,mo,1);stop=dt.date(2026,1,1) if mo==12 else dt.date(2025,mo+1,1)
        relevant=[r for r in bill if r['date'].startswith(f'2025-{mo:02d}')]
        s=(start-dt.date(1899,12,30)).days;e=(stop-dt.date(1899,12,30)).days
        sumrows.append([f'2025-{mo:02d}',formula(f'SUMIFS(\'Bills\'!F5:F{end},\'Bills\'!C5:C{end},">={s}",\'Bills\'!C5:C{end},"<{e}")',sum(r['cents'] for r in relevant)/100),len(relevant),None])
    sumrows.append(['CATEGORY TOTALS',None,None,None])
    for category in sorted(set(CATEGORY.values())):
        relevant=[r for r in bill if r['category']==category]
        sumrows.append([category,formula(f'SUMIFS(\'Bills\'!F5:F{end},\'Bills\'!E5:E{end},A{len(sumrows)+5})',sum(r['cents'] for r in relevant)/100),len(relevant),None])
    sumrows.append(['MERCHANT TOTALS',None,None,'Sorted by net retained amount at build time.'])
    merchants=sorted(set(r['merchant'] for r in bill),key=lambda m:(-sum(r['cents'] for r in bill if r['merchant']==m),m))
    for m in merchants:
        relevant=[r for r in bill if r['merchant']==m]
        sumrows.append([m,formula(f'SUMPRODUCT((\'Bills\'!D5:D{end}=A{len(sumrows)+5})*\'Bills\'!F5:F{end})',sum(r['cents'] for r in relevant)/100),len(relevant),'Largest merchant' if m==merchants[0] else None])
    high_cents=model['high_amount_cents']
    sumrows.append(['HIGH BILLS | absolute CAD >= '+threshold_label(high_cents),None,None,'Includes large refunds.'])
    for r in sorted(bill,key=lambda r:-abs(r['cents'])):
        if abs(r['cents'])<high_cents:continue
        rn=5+bill.index(r);sumrows.append([r['invoice'],formula(f"'Bills'!F{rn}",amt(r)),None,r['merchant']])
    result['Summary']=sumrows;return result
def build(dest,seed=42,high_cents=DEFAULT_HIGH_CENTS,use_llm=False):
    dest=Path(dest);dest.mkdir(parents=True,exist_ok=True)
    xlsx.fill(ROOT/'templates/input-template.xlsx',dest/'dirty-input.xlsx',generate(seed))
    model=clean(read_input(dest/'dirty-input.xlsx'),high_cents);model['seed']=seed;model['high_amount_cents']=high_cents
    dump(dest/'ledger.json',model)
    xlsx.fill(ROOT/'templates/output-template.xlsx',dest/'cleaned-bills.xlsx',workbook_tables(model))
    rec=model['reconciliation'];print('BUILD '+json.dumps(rec,sort_keys=True))
    if use_llm:
        cache=load_cache();validate_cache(cache)
        names=sorted({r['merchant'] for r in model['records'] if r['category']=='Uncategorised'})
        added,err=llm_fill(names,cache)
        if err:print('LLM step skipped, falling back to Uncategorised: '+err)
        else:
            if added:save_cache(cache)
            sug=llm_suggestions(model);dump(dest/'llm-suggestions.json',sug)
            where=f'{added} asked of the model, {len(sug["suggestions"])-added} from the cache' if added else 'all from the cache, no call made'
            print(f'LLM suggestions for {len(sug["suggestions"])} uncategorised merchants written to llm-suggestions.json ({where}; advisory; ledger unchanged; {sug["provider"]} · {sug["model"]})')
    return model
def normal(value):
    if isinstance(value,dt.date):return (value-dt.date(1899,12,30)).days
    if value=='':return None
    return value
def verify(dest,repeat=True,expected_high_cents=DEFAULT_HIGH_CENTS):
    dest=Path(dest);source=read_input(dest/'dirty-input.xlsx');got=json.loads((dest/'ledger.json').read_text(encoding='utf-8'))
    assert got.get('high_amount_cents')==expected_high_cents,'configured high-amount threshold does not match the built output'
    expected=clean(source,got['high_amount_cents']);expected['seed']=got['seed'];expected['high_amount_cents']=got['high_amount_cents']
    assert got==expected,'ledger differs from source-derived rows, reasons or changes'
    ids=[r['id'] for r in got['records']];assert len(ids)==len(set(ids))==len(source),'row identity coverage'
    assert len(source)==125,'expected 125 synthetic input rows'
    rec=got['reconciliation'];assert sum(rec['cents'].values())==rec['known_input_cents'],'amount reconciliation'
    assert sum(rec['counts'].values())==125,'partition count'
    review_count=sum(bool(r['reasons']) for r in got['records'])
    if got['seed']==42 and expected_high_cents==DEFAULT_HIGH_CENTS:
        assert review_count==39,'default CAD 2,500 threshold must produce exactly 39 review rows'
    # Independent raw amount arithmetic, separate from the category/disposition logic.
    known=sum(money(r['raw'][3]) for r in source if re.fullmatch(r'(?:\(?CAD |\$)?-?(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}\)?',r['raw'][3]))
    assert known==rec['known_input_cents'],'raw control total'
    scheme_pattern=re.compile(rb'<a:(?:theme|clrScheme|fontScheme|fmtScheme)\b[^>]*\bname="([^"]+)"')
    for book in (ROOT/'templates/input-template.xlsx',ROOT/'templates/output-template.xlsx',dest/'dirty-input.xlsx',dest/'cleaned-bills.xlsx'):
        parts=xlsx.files(book);schemes=[]
        for member,data in parts.items():
            assert b'<!--' not in data and b'-->' not in data,book.name+': XML comment found in '+member
            schemes.extend((member,name) for name in scheme_pattern.findall(data))
        assert schemes,book.name+': no named theme schemes found'
        assert all(name==b'Office' for _,name in schemes),book.name+': non-Office scheme name: '+repr(schemes)
    print('PASS all named theme schemes are Office and no XLSX member contains XML comments (4/4 workbooks)')
    output=xlsx.read(dest/'cleaned-bills.xlsx');tables=workbook_tables(expected)
    assert set(output)==set(tables),'worksheet set'
    for sheet,records in tables.items():
        actual={n:v for n,v in output[sheet].items() if n>=5}
        assert len(actual)==len(records),f'{sheet}: row count {len(actual)} != {len(records)}'
        for rn,record in enumerate(records,5):
            a=actual.get(rn,[]);b=[normal(v) for v in record]
            a=[normal(v) for v in a];a.extend([None]*(len(b)-len(a)))
            assert a==b,f'{sheet}!row {rn}: value/formula mismatch'
    print('PASS source coverage 125/125; disjoint partitions; known amounts reconcile to cents')
    print('PASS all 5 workbook sheets: rows, values, formulas, review reasons and field changes')
    # Evaluate this one reconciliation formula from stored summary inputs.
    # Decimal ROUND_HALF_UP matches Excel ROUND for positive and negative ties.
    # Other formulas are checked against expected text/caches, not evaluated here.
    from decimal import ROUND_HALF_UP
    cents=lambda v:int((Decimal(str(v))*100).quantize(Decimal('1'),rounding=ROUND_HALF_UP))
    values=[output['Summary'][n][1] for n in range(5,9)]
    values=[v['value'] if isinstance(v,dict) else v for v in values]
    difference_cents=sum(cents(v) for v in values[:3])-cents(values[3])
    assert difference_cents==0,'reconciliation formula evaluates to nonzero cents'
    assert output['Summary'][9][1]['value']==difference_cents/100==0,'reconciliation difference is not exact zero'
    print('PASS reconciliation formula: integer-cent difference = 0; cached difference == 0 (exact)')
    assert money('0.00')==0 and money('(CAD 1,250.00)')==-125000
    for invalid in ('12,34.00','1.999','USD 4.00','--1.00'):
        try:money(invalid)
        except ValueError:continue
        raise AssertionError('accepted invalid amount '+invalid)
    try:date('03/04/2025')
    except ValueError:pass
    else:raise AssertionError('ambiguous date accepted')
    assert any('possible duplicate' in ';'.join(r['reasons']) and r['status']=='clean' for r in got['records'])
    assert any(r['raw'][1].startswith('=') for r in got['records'])
    print('PASS zero/refund/invalid amount/ambiguous date/near duplicate/formula-like literal boundaries')
    cache=load_cache();validate_cache(cache)
    if (dest/'llm-suggestions.json').exists():
        sug=json.loads((dest/'llm-suggestions.json').read_text(encoding='utf-8'))
        assert sug==llm_suggestions(got),'llm-suggestions.json does not match the cache projection for this ledger'
        assert all(r['category']=='Uncategorised' for r in got['records'] if r['merchant'] in sug['suggestions']),'LLM suggestions must stay advisory: a suggested merchant was categorised in the ledger'
    print(f'PASS LLM cache well-formed ({len(cache["entries"])} entries) and suggestions, if present, are advisory and match the cache')
    if repeat:
        with scratch('.check-') as temp:
            p=Path(temp);build(p/'a',got['seed'],got['high_amount_cents']);build(p/'b',got['seed'],got['high_amount_cents'])
            for f in ('dirty-input.xlsx','cleaned-bills.xlsx'):
                assert xlsx.files(p/'a'/f)==xlsx.files(p/'b'/f)==xlsx.files(dest/f),'reproducibility XLSX members '+f
            assert (p/'a/ledger.json').read_bytes()==(p/'b/ledger.json').read_bytes()==(dest/'ledger.json').read_bytes(),'reproducibility ledger.json (UTF-8/LF bytes)'
            print('PASS seed '+str(got['seed'])+': two rebuilds and delivered files match (2/2 XLSX member sets + contents; 1/1 UTF-8/LF JSON bytes)')
    print('CHECK PASS')
def break_demo(dest):
    source=Path(dest)
    with scratch('.break-') as temp:
        p=Path(temp)
        for f in ('dirty-input.xlsx','cleaned-bills.xlsx','ledger.json'):(p/f).write_bytes((source/f).read_bytes())
        parts=xlsx.files(p/'cleaned-bills.xlsx');path=xlsx.sheet_paths(parts)['Bills'];root=xlsx.ET.fromstring(parts[path]);data=root.find(xlsx.tag('sheetData'))
        victim=next(r for r in data if r.get('r')=='5');data.remove(victim)
        parts[path]=xlsx.ET.tostring(root,encoding='utf-8',xml_declaration=True);xlsx.save_parts(p/'cleaned-bills.xlsx',parts)
        print('MUTATION removed Bills row 5 from a disposable copy',flush=True)
        command=[sys.executable,'-B',str(ROOT/'demo.py'),'check','--out',str(p),'--no-repeat']
        result=subprocess.run(command,capture_output=True,text=True,encoding='utf-8');print(result.stdout,end='');print(result.stderr,end='')
        print('CHILD_EXIT_CODE='+str(result.returncode))
        assert result.returncode==1 and 'Bills: row count' in result.stdout,'mutation did not trigger the intended check'
        print('EXPECTED FAILURE OBSERVED; delivered workbook unchanged')
    with scratch('.threshold-break-') as temp:
        p=Path(temp);(p/'templates').mkdir()
        for f in ('xlsx_io.py','llm.py'):(p/f).write_bytes((ROOT/f).read_bytes())
        for f in ('input-template.xlsx','output-template.xlsx'):(p/'templates'/f).write_bytes((ROOT/'templates'/f).read_bytes())
        code=(ROOT/'demo.py').read_bytes().replace(b'DEFAULT_HIGH_CENTS=250000',b'DEFAULT_HIGH_CENTS=100000')
        assert code!=(ROOT/'demo.py').read_bytes(),'threshold source mutation was not applied'
        (p/'demo.py').write_bytes(code)
        built=subprocess.run([sys.executable,'-B',str(p/'demo.py'),'build'],capture_output=True,text=True,encoding='utf-8')
        assert built.returncode==0,'threshold mutation build failed: '+built.stdout+built.stderr
        print('MUTATION changed the source default to CAD 1,000 and built a self-consistent disposable copy',flush=True)
        command=[sys.executable,'-B',str(p/'demo.py'),'check','--no-repeat']
        result=subprocess.run(command,capture_output=True,text=True,encoding='utf-8');print(result.stdout,end='');print(result.stderr,end='')
        print('CHILD_EXIT_CODE='+str(result.returncode))
        assert result.returncode==1 and 'must produce exactly 39 review rows' in result.stdout,'threshold mutation did not trigger the dedicated default review-count check'
        print('EXPECTED THRESHOLD FAILURE OBSERVED; only the default review-count assertion rejects this otherwise consistent build')
def break_cache():
    """Mutation 3: a cache entry outside the allowed category set must make `check` fail."""
    with scratch('.cache-break-') as temp:
        p=Path(temp);(p/'templates').mkdir();(p/'docs').mkdir();(p/'output').mkdir()
        for f in ('xlsx_io.py','demo.py','llm.py'):(p/f).write_bytes((ROOT/f).read_bytes())
        for f in ('input-template.xlsx','output-template.xlsx'):(p/'templates'/f).write_bytes((ROOT/'templates'/f).read_bytes())
        for f in ('dirty-input.xlsx','cleaned-bills.xlsx','ledger.json'):(p/'output'/f).write_bytes((ROOT/'output'/f).read_bytes())
        cache=load_cache();cache['entries']={'demoother06':{'merchant':'Demo Other 06','category':'Snacks','confidence':0.9,'reason':'mutated'}};cache['provider']=cache.get('provider') or 'anthropic';cache['model']=cache.get('model') or 'mutated';cache['generated']=cache.get('generated') or '2026-01-01'
        (p/'docs'/'llm-cache.json').write_text(json.dumps(cache),encoding='utf-8')
        print('MUTATION wrote a cache entry with category "Snacks" (outside the allowed set) into an isolated copy',flush=True)
        command=[sys.executable,'-B',str(p/'demo.py'),'check','--no-repeat']
        result=subprocess.run(command,capture_output=True,text=True,encoding='utf-8');print(result.stdout,end='');print(result.stderr,end='')
        print('CHILD_EXIT_CODE='+str(result.returncode))
        assert result.returncode==1 and 'category outside the allowed set' in result.stdout,'cache mutation did not trigger the cache validation'
        print('EXPECTED CACHE FAILURE OBSERVED; the real cache is untouched')
def main():
    p=argparse.ArgumentParser();p.add_argument('command',choices=['build','check','break','eval']);p.add_argument('--out',type=Path,default=ROOT/'output');p.add_argument('--seed',type=int,default=42);p.add_argument('--high-cad',type=threshold_cents,default=DEFAULT_HIGH_CENTS,metavar='AMOUNT');p.add_argument('--no-repeat',action='store_true');p.add_argument('--llm',action='store_true',help='build: ask a model about uncategorised merchants (LLM_PROVIDER anthropic|openai|gemini|openai-compatible, default anthropic; needs that provider\'s key and, except for Claude, LLM_MODEL; advisory, cached); eval: populate the eval cache');a=p.parse_args()
    try:
        if a.command=='build':build(a.out,a.seed,a.high_cad,a.llm)
        elif a.command=='check':verify(a.out,not a.no_repeat,a.high_cad)
        elif a.command=='eval':return eval_llm(a.llm)
        else:break_demo(a.out);break_cache()
    except (AssertionError,ValueError,KeyError,OSError) as e:print('FAIL: '+str(e));return 1
    return 0
if __name__=='__main__':sys.exit(main())
