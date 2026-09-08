#!/usr/bin/env python3
"""Single source of truth for PrognozaEPIR METAR/SPECI/TAF/SYNOP.

TAF policy is strict:
- historical TAF JSONL contains EPIR only;
- EPBY/EPPW/EPKS are current snapshots in data/messages/taf-neighbors.json;
- rebuilding METAR/SYNOP views must never regress a newer neighbor snapshot.
"""
from __future__ import annotations
import argparse, hashlib, json, re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
import collect_epir_observations as obs
import import_epir_bulk_archive as bulk

ROOT=Path(__file__).resolve().parents[1]; A=ROOT/'data/messages'
TYPES={'METAR':'metar','SPECI':'speci','TAF':'taf','SYNOP':'synop'}
STATE=A/'import-state.json'; MIG=A/'migration.json'
INPUTS=(ROOT/'data/import/epir',ROOT/'data/import/inbox',ROOT/'data/observations/manual')
TAF_NEIGHBORS=('EPBY','EPPW','EPKS')

def now(): return datetime.now(timezone.utc)
def iso(d): return d.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00','Z') if d else None
def dt(v):
    if isinstance(v,datetime): return (v if v.tzinfo else v.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    try: return datetime.fromisoformat(str(v or '').replace('Z','+00:00')).astimezone(timezone.utc)
    except: return None
def js(p,default):
    try: return json.loads(p.read_text(encoding='utf-8'))
    except: return default
def lines(p):
    out=[]
    if not p.exists(): return out
    for n,x in enumerate(p.read_text(encoding='utf-8').splitlines(),1):
        if not x.strip(): continue
        try: r=json.loads(x)
        except Exception as e: raise ValueError(f'{p}:{n}: {e}')
        if not isinstance(r,dict): raise ValueError(f'{p}:{n}: row is not object')
        out.append(r)
    return out
def write(p,text):
    if p.exists() and p.read_text(encoding='utf-8')==text: return False
    p.parent.mkdir(parents=True,exist_ok=True); p.write_text(text,encoding='utf-8'); return True
def writej(p,v,pretty=True):
    return write(p,(json.dumps(v,ensure_ascii=False,indent=2,sort_keys=True) if pretty else json.dumps(v,ensure_ascii=False,separators=(',',':'),sort_keys=True))+'\n')
def space(s): return re.sub(r'\s+',' ',str(s or '')).strip().strip('"')
def body(raw): return re.sub(r'^(?:METAR|SPECI)\s+','',space(raw).rstrip('='),flags=re.I).strip()
def canon(k,raw):
    s=space(raw).rstrip('=').strip()
    if k in ('METAR','SPECI'): return f'{k} {body(s)}='
    if k=='TAF' and not re.match(r'^TAF\b',s,re.I): s='TAF '+s
    return s+'='
def mid(k,station,c): return hashlib.sha256(f'{k}\n{station}\n{c}'.encode()).hexdigest()
def src(r,path=None):
    x={'name':r.get('source') or 'UNKNOWN'}
    if r.get('source_url'): x['url']=str(r['source_url'])
    f=path or r.get('source_file') or r.get('archive_source_file')
    if f: x['file']=str(f)
    return x
def merge_sources(a,b):
    out=[]; seen=set()
    for x in (a or [])+(b or []):
        if not isinstance(x,dict): continue
        k=json.dumps(x,sort_keys=True,ensure_ascii=False)
        if k not in seen: seen.add(k); out.append(x)
    return out

def kind(r,hint=None,speci=None):
    h=(hint or '').upper(); raw=space(r.get('raw')); rt=str(r.get('report_type') or '').upper()
    if h=='SYNOP' or raw.upper().startswith('AAXX '): return 'SYNOP'
    if h=='TAF' or raw.upper().startswith('TAF '): return 'TAF'
    if h in ('METAR','SPECI') or rt in ('METAR','SPECI') or re.match(r'^(METAR|SPECI)\b',raw,re.I):
        if h=='SPECI' or rt=='SPECI' or re.match(r'^SPECI\b',raw,re.I): return 'SPECI'
        if speci and r.get('obs_time') and (str(r['obs_time']),body(raw).upper()) in speci: return 'SPECI'
        return 'METAR'

def norm(r,hint=None,path=None,speci=None):
    if not isinstance(r,dict) or not r.get('raw'): return None
    k=kind(r,hint,speci)
    if not k: return None
    station=str(r.get('station') or ('12342' if k=='SYNOP' else 'EPIR')).upper()
    when=dt(r.get('issue_time') if k=='TAF' else r.get('obs_time'))
    if not when: return None
    c=canon(k,r['raw']); o=dict(r)
    o.update(schema='prognozaepir-message-v1',message_id=mid(k,station,c),type=k,station=station,message_time=iso(when),canonical_raw=c,raw=space(r['raw']),sources=merge_sources(r.get('sources'),[src(r,path)]))
    if k in ('METAR','SPECI'): o['report_type']=k
    return o

def dayfile(r):
    d=dt(r['message_time']); return A/TYPES[r['type']]/f'{d:%Y}'/f'{d:%m}'/f'{d:%d}.jsonl'
def ingest(rows):
    groups=defaultdict(list)
    for r in rows:
        if not r: continue
        # Neighbor TAFs are operational context only. Never create historical
        # JSONL rows for EPBY/EPPW/EPKS, regardless of the input source.
        if r.get('type')=='TAF' and str(r.get('station') or '').upper()!='EPIR':
            continue
        groups[dayfile(r)].append(r)
    stat={'input':0,'added':0,'duplicates':0,'enriched':0,'added_by_type':{x.lower():0 for x in TYPES},'files':[]}
    for p,inc in groups.items():
        cur={r['message_id']:r for r in lines(p) if r.get('message_id')}; changed=False
        for r in inc:
            stat['input']+=1; i=r['message_id']
            if i not in cur:
                cur[i]=r; stat['added']+=1; stat['added_by_type'][r['type'].lower()]+=1; changed=True; continue
            old=cur[i]; new=dict(old); new['sources']=merge_sources(old.get('sources'),r.get('sources'))
            for k,v in r.items():
                if k not in ('message_id','type','station','message_time','canonical_raw','raw','sources') and v not in (None,'') and new.get(k) in (None,''): new[k]=v
            if new!=old: cur[i]=new; stat['enriched']+=1; changed=True
            else: stat['duplicates']+=1
        out=sorted(cur.values(),key=lambda x:(x.get('message_time',''),x.get('message_id','')))
        text=''.join(json.dumps(x,ensure_ascii=False,separators=(',',':'),sort_keys=True)+'\n' for x in out)
        if changed or not p.exists() or p.read_text(encoding='utf-8')!=text:
            if write(p,text): stat['files'].append(str(p.relative_to(ROOT)))
    return stat

def filehash(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def input_files():
    out=[]
    for root in INPUTS:
        if root.exists(): out += [p for p in root.rglob('*') if p.is_file() and not p.name.lower().startswith('readme')]
    return sorted(set(out))
def manual(force=False):
    st=js(STATE,{'schema':'prognozaepir-message-import-state-v1','files':{}}); rec=[]; sh=set(); stats={'seen':0,'parsed':0,'messages':0,'rejected':0}
    for p in input_files():
        stats['seen']+=1; rel=str(p.relative_to(ROOT)); h=filehash(p)
        if not force and (st['files'].get(rel) or {}).get('sha256')==h: continue
        stats['parsed']+=1; counts=defaultdict(int)
        try:
            for t,report,_ in bulk.iter_records(p):
                up=report.upper(); r=None; k=None
                try:
                    if up.startswith('SPECI '): r=obs.decode_metar(report,t,source='MANUAL_ARCHIVE_IMPORT'); k='SPECI'
                    elif up.startswith('METAR '): r=obs.decode_metar(report,t,source='MANUAL_ARCHIVE_IMPORT'); k='METAR'
                    elif up.startswith('AAXX '): r=obs.decode_synop(report,t); k='SYNOP'
                    elif up.startswith('TAF '): r=bulk.decode_taf(report,t,rel); k='TAF'
                except: r=None
                if not r or not k: stats['rejected']+=1; continue
                r['source']='MANUAL_ARCHIVE_IMPORT'; r['source_file']=rel
                if k in ('METAR','SPECI'): r['report_type']=k
                n=norm(r,k,rel)
                if not n: stats['rejected']+=1; continue
                rec.append(n); counts[k.lower()]+=1; stats['messages']+=1
                if k=='SPECI': sh.add((str(n.get('obs_time')),body(n['raw']).upper()))
        except: stats['rejected']+=1
        st['files'][rel]={'sha256':h,**dict(counts)}
    return rec,sh,st,stats

def paths(root,full):
    if not root.exists(): return []
    if full: return sorted(root.rglob('*.jsonl'))
    out=[]
    for i in range(4):
        d=now()-timedelta(days=i)
        for p in (root/f'{d:%Y}'/f'{d:%m}'/f'{d:%d}.jsonl',root/f'{d:%Y-%m-%d}.jsonl'):
            if p.exists(): out.append(p)
    return out

def resolve(code,ref,mins=False):
    day,hour=int(code[:2]),int(code[2:4]); minute=int(code[4:6]) if mins else 0; c=[]
    for dm in (-1,0,1):
        y,m=ref.year,ref.month+dm
        if m<1:y-=1;m+=12
        if m>12:y+=1;m-=12
        try:c.append(datetime(y,m,day,hour,minute,tzinfo=timezone.utc))
        except:pass
    return min(c,key=lambda x:abs((x-ref).total_seconds())) if c else None
def taf_time(raw,ref):
    m=re.search(r'\b(\d{6})Z\b',space(raw)); return resolve(m.group(1),ref,True) if m else None

def legacy(full,speci):
    out=[]
    for root,h in ((ROOT/'data/observations/metar','METAR'),(ROOT/'data/observations/synop','SYNOP'),(ROOT/'data/taf/archive','TAF'),(ROOT/'data/taf/epir','TAF')):
        for p in paths(root,full):
            rel=str(p.relative_to(ROOT))
            for r in lines(p):
                n=norm(r,h,rel,speci)
                if n: out.append(n)
    l=js(ROOT/'data/observations/latest.json',{})
    for key,h in (('metar','METAR'),('synop','SYNOP')):
        if isinstance(l.get(key),dict):
            n=norm(l[key],h,'data/observations/latest.json',speci)
            if n: out.append(n)
    lt=js(ROOT/'data/taf/latest.json',{}).get('taf')
    if isinstance(lt,dict):
        n=norm(lt,'TAF','data/taf/latest.json'); out += [n] if n else []
    # IMPORTANT: data/taf/neighbors.json is deliberately NOT ingested here.
    # Current neighbor TAFs are copied into data/messages/taf-neighbors.json by
    # the TAF finalizer and are never historical/learning records.
    return out

def stream(k,since=None):
    root=A/TYPES[k]; out=[]
    if not root.exists(): return out
    if since:
        d=since.date(); end=now().date()+timedelta(days=1); ps=[]
        while d<=end:
            p=root/f'{d:%Y}'/f'{d:%m}'/f'{d:%d}.jsonl'; ps += [p] if p.exists() else []; d+=timedelta(days=1)
    else: ps=sorted(root.rglob('*.jsonl'))
    for p in ps: out += [r for r in lines(p) if r.get('type')==k]
    return sorted(out,key=lambda r:(r.get('message_time',''),r.get('message_id','')))

def prune_neighbor_taf_history():
    root=A/'taf'; removed=0
    if not root.exists(): return removed
    for p in sorted(root.rglob('*.jsonl')):
        rows=lines(p); keep=[r for r in rows if str(r.get('station') or '').upper()=='EPIR']
        removed += len(rows)-len(keep)
        if keep:
            text=''.join(json.dumps(x,ensure_ascii=False,separators=(',',':'),sort_keys=True)+'\n' for x in sorted(keep,key=lambda x:(x.get('message_time',''),x.get('message_id',''))))
            write(p,text)
        elif p.exists():
            p.unlink()
    return removed

def neighbor_snapshot():
    snap=js(A/'taf-neighbors.json',{})
    rows={}
    for station,row in (snap.get('stations') or {}).items():
        sid=str(station or '').upper()
        if sid in TAF_NEIGHBORS and isinstance(row,dict) and row.get('raw'):
            rows[sid]=row
    return snap,rows

def views(stat,full=False):
    since=now()-timedelta(hours=40)
    m=[x for x in stream('METAR',since) if x.get('station')=='EPIR']
    sp=[x for x in stream('SPECI',since) if x.get('station')=='EPIR']
    sy=[x for x in stream('SYNOP',since) if x.get('station')=='12342']
    tf=[x for x in stream('TAF',now()-timedelta(hours=72)) if x.get('station')=='EPIR']
    av=sorted(m+sp,key=lambda x:x['message_time'])
    snap,neighbors=neighbor_snapshot()
    tb={}
    if tf: tb['EPIR']=tf[-1]
    tb.update(neighbors)
    latest={'schema':'prognozaepir-message-archive-latest-v1','archive':'data/messages','station':{'icao':'EPIR','synop':'12342','wigos':'0-20000-0-12342','lat':52.83,'lon':18.33},'metar':av[-1] if av else None,'metar_only':m[-1] if m else None,'speci':sp[-1] if sp else None,'aviation':av[-1] if av else None,'synop':sy[-1] if sy else None,'taf':tf[-1] if tf else None,'taf_by_station':tb,'taf_neighbors_current':neighbors}
    candidates=[x for x in (latest['aviation'],latest['synop'],latest['taf'],*neighbors.values()) if isinstance(x,dict) and x.get('message_time')]
    latest['updated_at']=max([x['message_time'] for x in candidates],default=None)
    try: latest['fused']=obs.fuse(latest['aviation'],latest['synop'])
    except: latest['fused']=None
    try: hist=obs.history(av,sy)
    except: hist=[]
    recent={'schema':'prognozaepir-message-archive-recent-v1','archive':'data/messages','hours':40,'station':latest['station'],'metar':av,'metar_only':m,'speci':sp,'aviation':av,'synop':sy,'taf':tf,'taf_neighbors_current':neighbors,'observations':hist}
    writej(A/'latest.json',latest); writej(A/'recent.json',recent,False)
    prev=js(A/'status.json',{})
    if full or not prev.get('counts'):
        counts={k.lower():len(stream(k)) for k in TYPES}
        last={k.lower():(stream(k)[-1]['message_time'] if stream(k) else None) for k in TYPES}
    else:
        counts={k.lower():int((prev.get('counts') or {}).get(k.lower(),0))+int(stat['added_by_type'].get(k.lower(),0)) for k in TYPES}
        last=dict(prev.get('latest') or {})
        for k,row in {'metar':latest['metar_only'],'speci':latest['speci'],'synop':latest['synop']}.items():
            if row and (not last.get(k) or row['message_time']>last[k]): last[k]=row['message_time']
    # TAF is small enough to recount every run. This also repairs any old count
    # that included neighbor snapshots by mistake.
    all_epir_taf=[x for x in stream('TAF') if x.get('station')=='EPIR']
    counts['taf']=len(all_epir_taf)
    last['taf']=all_epir_taf[-1]['message_time'] if all_epir_taf else None
    writej(A/'status.json',{'schema':'prognozaepir-message-archive-status-v1','archive':'data/messages','types':list(TYPES),'counts':counts,'latest':last,'archive_updated_at':latest['updated_at'],'deduplication':'sha256(type + station + canonical_raw)','legacy_archives_authoritative':False,'taf_history_scope':'EPIR only','taf_neighbors':'current snapshot only; not archived; not learning data'})
    return counts

def validate():
    n=0
    for k,d in TYPES.items():
        root=A/d
        if not root.exists(): continue
        for p in root.rglob('*.jsonl'):
            seen=set()
            for r in lines(p):
                n+=1
                if r.get('type')!=k or not r.get('message_id') or not r.get('canonical_raw') or not r.get('message_time'): raise ValueError(f'bad record {p}')
                if k=='TAF' and str(r.get('station') or '').upper()!='EPIR': raise ValueError(f'neighbor TAF leaked into history: {p} {r.get("station")}')
                if r['message_id'] in seen: raise ValueError(f'duplicate {p} {r["message_id"]}')
                seen.add(r['message_id'])
                if r['message_id']!=mid(k,str(r.get('station') or ''),str(r['canonical_raw'])): raise ValueError(f'bad hash {p}')
    for x in ('latest.json','recent.json','status.json'): json.loads((A/x).read_text(encoding='utf-8'))
    latest=js(A/'latest.json',{})
    snapshot=js(A/'taf-neighbors.json',{}).get('stations') or {}
    for station in TAF_NEIGHBORS:
        snap=snapshot.get(station)
        shown=(latest.get('taf_by_station') or {}).get(station)
        if snap and shown and dt(shown.get('message_time')) and dt(snap.get('message_time')) and dt(shown.get('message_time')) < dt(snap.get('message_time')):
            raise ValueError(f'{station} regressed behind central neighbor snapshot')
    return n

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--full-migrate',action='store_true'); ap.add_argument('--force-import',action='store_true'); ap.add_argument('--validate-only',action='store_true'); a=ap.parse_args()
    if a.validate_only: print(json.dumps({'checked_records':validate()})); return
    mig=js(MIG,{}); full=a.full_migrate or not mig.get('complete'); man,sh,state,ms=manual(a.force_import or full); leg=legacy(full,sh); st=ingest(leg+man)
    removed=prune_neighbor_taf_history()
    if full: writej(MIG,{'schema':'prognozaepir-message-migration-v1','complete':True,'legacy_roots':['data/observations/metar','data/observations/synop','data/taf/archive','data/taf/epir']})
    writej(STATE,state); counts=views(st,full); checked=validate(); print(json.dumps({'full_migration':full,'legacy_seen':len(leg),'manual':ms,'ingest':st,'neighbor_taf_history_removed':removed,'counts':counts,'checked':checked},ensure_ascii=False,indent=2))
if __name__=='__main__': main()
