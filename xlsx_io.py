"""Small OOXML reader/template filler, intentionally limited to this demo's schema.

No macro, formula-input, merged-body, or arbitrary-style conversion support.
Templates are authored separately; the application preserves their styles/panes.
"""
import copy
import datetime as dt
import posixpath
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
ET.register_namespace('', NS)
ET.register_namespace('r', REL)
def tag(s): return '{'+NS+'}'+s
def col(n):
    result = ''
    while n:
        n, r = divmod(n-1, 26)
        result = chr(65+r)+result
    return result
def index(ref):
    result = 0
    for c in re.match('[A-Z]+', ref)[0]: result = result*26+ord(c)-64
    return result-1
def files(path):
    with zipfile.ZipFile(path) as z:
        names=z.namelist()
        if len(names)!=len(set(names)):raise ValueError('duplicate XLSX member name')
        return {n:z.read(n) for n in names}
def sheet_paths(parts):
    rels = ET.fromstring(parts['xl/_rels/workbook.xml.rels'])
    targets = {r.get('Id'):posixpath.normpath(posixpath.join('xl',r.get('Target'))).lstrip('/') for r in rels}
    return {s.get('name'):targets[s.get('{'+REL+'}id')] for s in ET.fromstring(parts['xl/workbook.xml']).find(tag('sheets'))}
def read(path):
    parts=files(path); strings=[]
    if 'xl/sharedStrings.xml' in parts:
        strings=[''.join(n.itertext()) for n in ET.fromstring(parts['xl/sharedStrings.xml'])]
    out={}
    for name,p in sheet_paths(parts).items():
        rows={}
        for row in ET.fromstring(parts[p]).find(tag('sheetData')):
            values=[]
            for c in row:
                i=index(c.get('r')); values.extend([None]*(i+1-len(values)))
                v=c.find(tag('v')); kind=c.get('t')
                value=None if v is None else v.text
                if kind=='s': value=strings[int(value)]
                elif kind=='inlineStr': value=''.join(c.find(tag('is')).itertext())
                elif value is not None and kind not in ('str','e'):
                    value=float(value); value=int(value) if value.is_integer() else value
                if c.find(tag('f')) is not None: value={'formula':c.find(tag('f')).text,'value':value}
                values[i]=value
            rows[int(row.get('r'))]=values
        out[name]=rows
    return out
def save_parts(path,parts):
    Path(path).parent.mkdir(parents=True,exist_ok=True)
    # Stored members avoid zlib/zlib-ng byte differences. Checks still accept
    # other compressors when member names and uncompressed bytes are identical.
    with zipfile.ZipFile(path,'w',zipfile.ZIP_STORED) as z:
        for name,data in sorted(parts.items()):
            info=zipfile.ZipInfo(name,(2000,1,1,0,0,0))
            info.compress_type=zipfile.ZIP_STORED
            info.create_system=0
            info.create_version=20;info.extract_version=20
            info.external_attr=0o600 << 16;info.internal_attr=0
            info.flag_bits=0;info.volume=0;info.extra=b'';info.comment=b''
            z.writestr(info,data)
def fill(template,path,sheets):
    parts=files(template)
    for name,p in sheet_paths(parts).items():
        root=ET.fromstring(parts[p]);data=root.find(tag('sheetData'))
        style={}
        for row in data:
            for c in row: style[(int(row.get('r')),index(c.get('r')))]=c.get('s','0')
        for row in list(data):
            if int(row.get('r'))>=5:data.remove(row)
        records=sheets[name]
        for rn,values in enumerate(records,5):
            row=ET.SubElement(data,tag('row'),{'r':str(rn),'ht':'29','customHeight':'1'})
            for cn,value in enumerate(values):
                if value is None:continue
                c=ET.SubElement(row,tag('c'),{'r':col(cn+1)+str(rn),'s':style.get((5,cn),'0')})
                if isinstance(value,dt.date):value=(value-dt.date(1899,12,30)).days
                if isinstance(value,dict):
                    ET.SubElement(c,tag('f')).text=value['formula'];ET.SubElement(c,tag('v')).text=str(value['value'])
                elif isinstance(value,(float,int)):
                    ET.SubElement(c,tag('v')).text=str(value)
                else:
                    c.set('t','inlineStr');t=ET.SubElement(ET.SubElement(c,tag('is')),tag('t'))
                    t.set('{http://www.w3.org/XML/1998/namespace}space','preserve');t.text=str(value)
        dim=root.find(tag('dimension'))
        width=max([len(v) for v in records]+[1])
        if dim is not None:dim.set('ref',f'A1:{col(width)}{len(records)+4}')
        auto=root.find(tag('autoFilter'))
        if auto is None:
            auto=ET.Element(tag('autoFilter'));root.insert(list(root).index(data)+1,auto)
        auto.set('ref',f'A4:{col(width)}{max(5,len(records)+4)}')
        parts[p]=ET.tostring(root,encoding='utf-8',xml_declaration=True)
    save_parts(path,parts)
