#!/usr/bin/env python3
"""Incremental bulk importer for EPIR METAR/SYNOP/TAF archives."""
import argparse,base64,bz2,gzip,hashlib,json,re,sys
from collections import defaultdict
from datetime import datetime,timedelta,timezone
from pathlib import Path
R=Path(__file__).resolve().parents[1]; IN=R/'data/import/inbox'; STATE=R/'data/import/import-state.json'; OBS=R/'data/observations'; TAF=R/'data/taf/archive'; VER=2
TS=[re.compile(r'(?P<y>20\d{2})[-/.](?P<m>\d{2})[-/.](?P<d>\d{2})[ T](?P<h>\d{2}):(?P<i>\d{2})(?::(?P<s>\d{2}))?',re.I),re.compile(r'(?P<d>\d{2})[-/.](?P<m>\d{2})[-/.](?P<y>20\d{2})[ T](?P<h>\d{2}):(?P<i>\d{2})(?::(?P<s>\d{2}))?',re.I)]
START=re.compile(r'\b(?:METAR|SPECI)(?:\s+(?:COR|AMD))?\s+EPIR\b|\bAAXX\s+\d{5}\s+12342\b|\bTAF(?:\s+(?:AMD|COR))?\s+EPIR\b',re.I)
def iso(d): return d.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00','Z') if d else None
def dt(s):
 for x in TS:
  m=x.search(str(s))
  if m:
   try:return datetime(int(m['y']),int(m['m']),int(m['d']),int(m['h']),int(m['i']),int(m['s'] or 0),tzinfo=timezone.utc)
   except:pass
 return None
def norm(s):
 s=re.sub(r'\s+',' ',str(s).strip().strip('|\t,;\"\'')); return s[:s.find('=')+1].strip() if '=' in s else s.strip()
def kind(s):
 u=s.upper()
 if re.match(r'^(?:METAR|SPECI)(?:\s+(?:COR|AMD))?\s+EPIR\b',u):return'metar'
 if re.match(r'^AAXX\s+\d{5}\s+12342\b',u):return'synop'
 if re.match(r'^TAF(?:\s+(?:AMD|COR))?\s+EPIR\b',u):return'taf'
def extract(text):
 out={}
 for line in text.replace('\ufeff','').splitlines():
  line=line.strip()
  if not line:continue
  try:
   o=json.loads(line)
   if isinstance(o,dict):
    rep=next((o.get(k) for k in('report','raw','message','telegram','metar','synop','taf') if isinstance(o.get(k),str)),None); ts=next((o.get(k) for k in('timestamp_utc','timestamp','obs_time','issue_time','time','datetime') if o.get(k)),None)
    if rep and ts:
     d=dt(ts); rep=norm(rep)
     if d and kind(rep):out[(iso(d),rep)]=(d,rep);continue
  except:pass
  m=START.search(line); d=dt(line)
  if m and d:
   rep=norm(line[m.start():])
   if kind(rep):out[(iso(d),rep)]=(d,rep)
 return sorted(out.values(),key=lambda x:(x[0],x[1]))
def readsrc(p):
 b=p.read_bytes(); n=p.name.lower()
 if n.endswith('.bz2.b64'):return bz2.decompress(base64.b64decode(b.strip(),validate=True)).decode('utf8','replace')
 if n.endswith('.gz.b64'):return gzip.decompress(base64.b64decode(b.strip(),validate=True)).decode('utf8','replace')
 if n.endswith('.b64'):return base64.b64decode(b.strip(),validate=True).decode('utf8','replace')
 if n.endswith('.bz2'):return bz2.decompress(b).decode('utf8','replace')
 if n.endswith('.gz'):return gzip.decompress(b).decode('utf8','replace')
 return b.decode('utf8','replace')
def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def load(p):
 if not p.exists():return[]
 a=[]
 for l in p.read_text(encoding='utf8').splitlines():
  try:
   x=json.loads(l)
   if isinstance(x,dict):a.append(x)
  except:pass
 return a
def write(p,a):
 p.parent.mkdir(parents=True,exist_ok=True); s=''.join(json.dumps(x,ensure_ascii=False,separators=(',',':'))+'\n' for x in a); old=p.read_text(encoding='utf8') if p.exists() else None
 if s==old:return False
 p.write_text(s,encoding='utf8');return True
def mergeobs(p,new):
 keys={(x.get('station'),x.get('obs_time')) for x in new}; a=[x for x in load(p) if(x.get('station'),x.get('obs_time'))not in keys]+new; a.sort(key=lambda x:(x.get('obs_time')or'',x.get('station')or''));return write(p,a)
def ddhh(code,ref):
 day,h=map(int,(code[:2],code[2:])); c=[]
 for sh in(-1,0,1):
  y,m=ref.year,ref.month+sh
  while m<1:y-=1;m+=12
  while m>12:y+=1;m-=12
  try:c.append(datetime(y,m,day,tzinfo=timezone.utc)+timedelta(hours=h))
  except:pass
 return min(c,key=lambda x:abs((x-ref).total_seconds())) if c else None
def tafrow(d,raw,src):
 raw=norm(raw); v='AMD' if re.match(r'^TAF\s+AMD\b',raw,re.I) else 'COR' if re.match(r'^TAF\s+COR\b',raw,re.I) else'NORMAL'; m=re.search(r'\b(\d{4})/(\d{4})\b',raw); a=b=None
 if m:
  a=ddhh(m[1],d); b=ddhh(m[2],a+timedelta(hours=12)) if a else None
  if a and b and b<=a:b+=timedelta(days=1)
 return{'schema':'prognozaepir-taf-archive-v1','source':'EPIR_BULK_ARCHIVE_IMPORT','source_file':src,'station':'EPIR','issue_time':iso(d),'valid_from':iso(a),'valid_to':iso(b),'variant':v,'cancelled':bool(re.search(r'\bCNL\b',raw,re.I)),'raw':raw}
def mergetaf(p,new):
 u={}
 for x in load(p)+new:u[(x.get('station'),x.get('issue_time'),x.get('raw'))]=x
 return write(p,sorted(u.values(),key=lambda x:(x.get('issue_time')or'',x.get('raw')or'')))
def state():
 try:s=json.loads(STATE.read_text(encoding='utf8'))
 except:s={}
 if s.get('parser_version')!=VER:s={'schema':'prognozaepir-bulk-import-state-v1','parser_version':VER,'files':{}}
 s.setdefault('files',{});return s
def main():
 ap=argparse.ArgumentParser();ap.add_argument('--dry-run',action='store_true');ap.add_argument('--force',action='store_true');a=ap.parse_args();st=state(); allf=[p for p in sorted(IN.rglob('*')) if p.is_file() and not p.name.startswith('.')]; rec=[]; meta={};skip=0
 for p in allf:
  rel=p.relative_to(R).as_posix(); h=digest(p)
  if not a.force and st['files'].get(rel,{}).get('sha256')==h:skip+=1;continue
  rr=extract(readsrc(p)); cnt={k:sum(kind(x[1])==k for x in rr) for k in('metar','synop','taf')};meta[rel]={'sha256':h,'records':len(rr),**cnt};rec += [(d,r,kind(r),rel) for d,r in rr]
 summ={'files_seen':len(allf),'files_processed':len(meta),'files_skipped_unchanged':skip,**{f'extracted_{k}':sum(x[2]==k for x in rec) for k in('metar','synop','taf')},'per_file':meta}
 if a.dry_run:print(json.dumps(summ,indent=2));return
 sys.path.insert(0,str(R/'scripts'));import collect_epir_observations as c
 g={'metar':defaultdict(list),'synop':defaultdict(list)};t=defaultdict(list);bad=[]
 for d,r,k,src in rec:
  try:
   if k=='metar':x=c.decode_metar(r,d,source='EPIR_BULK_ARCHIVE_METAR')
   elif k=='synop':x=c.decode_synop(r,d); x and x.update(source='EPIR_BULK_ARCHIVE_SYNOP_RAW')
   else:x=tafrow(d,r,src)
   if x and k in g:x['archive_source_file']=src
  except Exception as e:x=None;err=str(e)
  if not x:bad.append({'source_file':src,'time':iso(d),'report':r,'error':locals().get('err','decoder rejected')});continue
  day=d.strftime('%Y-%m-%d');(g[k][day] if k in g else t[day]).append(x)
 changed=[]
 for k in('metar','synop'):
  for day,rows in g[k].items():
   u={}
   for x in rows:u[(x.get('station'),x.get('obs_time'))]=x
   rows=sorted(u.values(),key=lambda x:x.get('obs_time')or'');y,m,d=day.split('-')
   for p in(OBS/k/f'{day}.jsonl',OBS/k/y/m/f'{d}.jsonl'):
    if mergeobs(p,rows):changed.append(str(p.relative_to(R)))
 for day,rows in t.items():
  y,m,d=day.split('-');p=TAF/y/m/f'{d}.jsonl'
  if mergetaf(p,rows):changed.append(str(p.relative_to(R)))
 summ['rejected']=len(bad);summ['changed_files']=changed
 if bad:
  q=R/'data/import/last-rejected.json';q.parent.mkdir(parents=True,exist_ok=True);q.write_text(json.dumps(bad,ensure_ascii=False,indent=2)+'\n',encoding='utf8');print(json.dumps(summ,indent=2));raise SystemExit(2)
 now=iso(datetime.now(timezone.utc))
 for rel,x in meta.items():st['files'][rel]={**x,'imported_at':now}
 STATE.parent.mkdir(parents=True,exist_ok=True);STATE.write_text(json.dumps(st,ensure_ascii=False,indent=2,sort_keys=True)+'\n',encoding='utf8');print(json.dumps(summ,indent=2))
if __name__=='__main__':main()
