#!/usr/bin/env python3
import csv, html, io, json, math, re
import urllib.parse, urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ICAO='EPIR'; SYNOP_ID='12342'; WIGOS_ID='0-20000-0-12342'
LAT=52.83; LON=18.33; OUT=Path('data/observations')
UA='Mozilla/5.0 (compatible; PrognozaEPIR/1.0; +https://github.com/MARSTER-ORG/PrognozaEPIR)'

def now(): return datetime.now(timezone.utc)
def iso(d): return d.astimezone(timezone.utc).isoformat().replace('+00:00','Z') if d else None
def fnum(v):
    try:
        x=float(v); return x if math.isfinite(x) else None
    except Exception: return None
def rnd(v,n=1): return round(v,n) if v is not None and math.isfinite(v) else None
def parse_dt(v):
    if not v:return None
    if isinstance(v,(int,float)):return datetime.fromtimestamp(float(v),timezone.utc)
    try:
        d=datetime.fromisoformat(str(v).strip().replace('Z','+00:00'))
        return (d if d.tzinfo else d.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)
    except Exception:return None
def rh(T,Td):
    if T is None or Td is None:return None
    a,b=17.625,243.04
    return max(0,min(100,100*math.exp(a*Td/(b+Td)-a*T/(b+T))))
def get_text(url,timeout=30):
    q=urllib.request.Request(url,headers={'User-Agent':UA,'Accept':'text/plain,text/csv,text/html,*/*;q=.8'})
    with urllib.request.urlopen(q,timeout=timeout) as r:return r.read().decode('utf-8','replace')
def get_json(url):return json.loads(get_text(url))

def ogimet(kind,hours):
    e=now()+timedelta(minutes=5); b=e-timedelta(hours=hours)
    if kind=='metar': base='https://www.ogimet.com/cgi-bin/getmetar'; key='icao'; val=ICAO
    else: base='https://www.ogimet.com/cgi-bin/getsynop'; key='block'; val=SYNOP_ID[:3]
    p={key:val,'begin':b.strftime('%Y%m%d%H%M'),'end':e.strftime('%Y%m%d%H%M'),'header':'yes','lang':'eng'}
    return get_text(base+'?'+urllib.parse.urlencode(p))
def csv_rows(text,station):
    a=[]
    for row in csv.reader(io.StringIO(text)):
        if len(row)<7 or row[0].strip().upper()!=station.upper():continue
        try:d=datetime(int(row[1]),int(row[2]),int(row[3]),int(row[4]),int(row[5]),tzinfo=timezone.utc)
        except Exception:continue
        a.append((d,','.join(row[6:]).strip()))
    return sorted(a,reverse=True,key=lambda z:z[0])

# ---------------- METAR ----------------
def metar_temp(s): return (-1 if s.startswith('M') else 1)*int(s.lstrip('M')) if s else None
def metar_vis(raw):
    if re.search(r'\bCAVOK\b',raw):return 10000,True,False,'CAVOK'
    toks=raw.split()
    for i,t in enumerate(toks):
        if re.fullmatch(r'(?:\d{3}|VRB)\d{2,3}(?:G\d{2,3})?KT',t):
            for z in toks[i+1:i+4]:
                if re.fullmatch(r'\d{4}',z):
                    v=int(z); return (10000,True,False,'9999') if v==9999 else (v,False,False,z)
    return None,None,None,None
def decode_metar(raw,t=None,source='OGIMET_METAR'):
    raw=html.unescape(re.sub(r'\s+',' ',raw or '')).strip().strip('"')
    raw=re.sub(r'^METAR\s*=\s*','',raw,flags=re.I); raw=re.sub(r'^(METAR|SPECI)\s+','',raw,flags=re.I)
    if not re.search(r'\bEPIR\b',raw) or re.search(r'\bNIL\b',raw):return None
    if not t:
        m=re.search(r'\b(\d{2})(\d{2})(\d{2})Z\b',raw)
        if m:
            dd,hh,mm=map(int,m.groups()); ref=now(); cand=[]
            for dm in (-1,0,1):
                y,mo=ref.year,ref.month+dm
                if mo<1:y-=1;mo+=12
                if mo>12:y+=1;mo-=12
                try:cand.append(datetime(y,mo,dd,hh,mm,tzinfo=timezone.utc))
                except ValueError:pass
            if cand:t=min(cand,key=lambda d:abs((d-ref).total_seconds()))
    v,vlb,vub,vrep=metar_vis(raw)
    w=re.search(r'\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b',raw)
    wd=None if not w or w.group(1)=='VRB' else int(w.group(1)); ws=int(w.group(2))*.514444 if w else None; gust=int(w.group(3))*.514444 if w and w.group(3) else None
    q=re.search(r'\b(M?\d{2})/(M?\d{2})\b',raw); T=metar_temp(q.group(1)) if q else None; Td=metar_temp(q.group(2)) if q else None
    p=re.search(r'\bQ(\d{4})\b',raw); pressure=int(p.group(1)) if p else None
    codes=set(re.findall(r'(?<![A-Z])(FZFG|MIFG|BCFG|PRFG|FG|BR)(?![A-Z])',raw))
    clouds=[]
    for c,h in re.findall(r'\b(FEW|SCT|BKN|OVC|VV)(\d{3})\b',raw):
        ft=int(h)*100; clouds.append({'cover':c,'base_ft_agl':ft,'base_m_agl':round(ft*.3048)})
    ceil=next((c['base_m_agl'] for c in clouds if c['cover'] in ('BKN','OVC','VV')),None)
    return {'source':source,'station':ICAO,'obs_time':iso(t),'temperature_c':T,'dew_point_c':Td,'relative_humidity_pct':rnd(rh(T,Td),1),
      'visibility_m':v,'visibility_lower_bound':vlb,'visibility_upper_bound':vub,'visibility_report':vrep,'wind_direction_deg':wd,'wind_speed_ms':rnd(ws,2),'wind_gust_ms':rnd(gust,2),
      'pressure_hpa':pressure,'weather':' '.join(sorted(codes)) or None,'fog':any(x.endswith('FG') for x in codes),'mist':'BR' in codes,'freezing_fog':'FZFG' in codes,
      'ceiling_m_agl':ceil,'clouds':clouds,'raw':raw}
def metar_czad():
    text=get_text('https://metar.czad.org/'); plain=html.unescape(re.sub(r'<[^>]+>',' ',text)); plain=re.sub(r'\s+',' ',plain)
    m=re.search(r'METAR\s*=\s*(EPIR\s+\d{6}Z\s+.*?\bQ\d{4}\b)',plain,re.I)
    return decode_metar(m.group(1),source='METAR_CZAD') if m else None
def metar_imgw():
    text=get_text('https://awiacja.imgw.pl/metar-i-taf'); plain=html.unescape(re.sub(r'<[^>]+>',' ',text)); plain=re.sub(r'\s+',' ',plain)
    m=re.search(r'\b(EPIR\s+\d{6}Z\s+.*?\bQ\d{4}\b)',plain,re.I)
    return decode_metar(m.group(1),source='IMGW_AVIATION_METAR') if m else None
def get_metar():
    for fn in (metar_imgw,lambda: next((decode_metar(r,t) for t,r in csv_rows(ogimet('metar',6),ICAO) if decode_metar(r,t)),None),metar_czad):
        try:
            x=fn()
            if x:return x
        except Exception as e:print('METAR source warning:',e)
    return None

# ---------------- SYNOP FM-12 ----------------
def signed10(g):
    if not g or len(g)!=5 or g[1] not in '01' or not g[2:].isdigit():return None
    v=int(g[2:])/10; return -v if g[1]=='1' else v
def press(g):
    if not g or len(g)!=5 or not g[1:].isdigit():return None
    v=int(g[1:])/10; return v+1000 if v<500 else v
def vv_decode(s):
    try:c=int(s)
    except:return None,None,None,None
    if c==0:return 50,False,True,'<100 m'
    if 1<=c<=50:return c*100,False,False,f'{c*100} m'
    if 51<=c<=55:return None,None,None,'unused'
    if 56<=c<=80:
        m=(c-50)*1000; return m,False,False,f'{m} m'
    if 81<=c<=88:
        m=(c-74)*5000; return m,False,False,f'{m} m'
    if c==89:return 70000,True,False,'>70000 m'
    sp={90:(50,False,True,'<50 m'),91:(50,False,False,'50 m'),92:(200,False,False,'200 m'),93:(500,False,False,'500 m'),94:(1000,False,False,'1000 m'),95:(2000,False,False,'2000 m'),96:(4000,False,False,'4000 m'),97:(10000,False,False,'10000 m'),98:(20000,False,False,'20000 m'),99:(50000,True,False,'≥50000 m')}
    return sp.get(c,(None,None,None,None))
def h_decode(h):return {'0':25,'1':75,'2':150,'3':250,'4':450,'5':800,'6':1250,'7':1750,'8':2250,'9':3000}.get(h)
def wx_decode(ww):
    if ww is None:return False,False,False,None
    fog=40<=ww<=49; mist=ww==10; fr=ww in (48,49)
    return fog,mist,fr,('fog' if fog else 'mist' if mist else 'present weather')+f' (ww={ww:02d})'
def decode_synop(raw,t):
    raw=re.sub(r'\s+',' ',raw or '').strip().strip('"'); toks=raw.split()
    if 'NIL' in raw.upper() or SYNOP_ID not in toks:return None
    i=toks.index(SYNOP_ID); bef=toks[:i]; a=toks[i+1:]
    if len(a)<2:return None
    iw=None
    for z in reversed(bef):
        if re.fullmatch(r'\d{5}',z):iw=int(z[-1]);break
    g0=a[0] if re.fullmatch(r'[0-9/]{5}',a[0]) else None; g1=a[1] if re.fullmatch(r'[0-9/]{5}',a[1]) else None
    vis=vv_decode(g0[-2:]) if g0 else (None,None,None,None); cbh=h_decode(g0[2]) if g0 else None
    wd=ws=N=None
    if g1:
        N=int(g1[0]) if g1[0].isdigit() and int(g1[0])<=8 else None
        if g1[1:3].isdigit():wd=None if g1[1:3]=='99' else int(g1[1:3])*10
        if g1[3:5].isdigit():ws=int(g1[3:5])*(.514444 if iw in (3,4) else 1)
    T=Td=p0=pmsl=None; ww=None; sec=1
    for z in a[2:]:
        if z in ('222','333','444','555'):sec=int(z[0]);continue
        if sec!=1 or not re.fullmatch(r'[0-9/]{5}',z):continue
        if z[0]=='1' and T is None:T=signed10(z)
        elif z[0]=='2' and Td is None:Td=signed10(z)
        elif z[0]=='3' and p0 is None:p0=press(z)
        elif z[0]=='4' and pmsl is None:pmsl=press(z)
        elif z[0]=='7' and z[1:3].isdigit() and ww is None:ww=int(z[1:3])
    fog,mist,fr,wxt=wx_decode(ww); vm,vlb,vub,vrep=vis
    return {'source':'OGIMET_SYNOP_RAW','station':SYNOP_ID,'wigos':WIGOS_ID,'obs_time':iso(t),'temperature_c':rnd(T,1),'dew_point_c':rnd(Td,1),'relative_humidity_pct':rnd(rh(T,Td),1),
      'visibility_m':vm,'visibility_lower_bound':vlb,'visibility_upper_bound':vub,'visibility_report':vrep,'visibility_code_vv':g0[-2:] if g0 else None,
      'wind_direction_deg':wd,'wind_speed_ms':rnd(ws,2),'pressure_hpa':rnd(pmsl if pmsl is not None else p0,1),'station_pressure_hpa':rnd(p0,1),
      'present_weather_code':ww,'present_weather':wxt,'fog':fog,'mist':mist,'freezing_fog':fr,'cloud_base_m_agl':cbh,'total_cloud_oktas':N,'raw':raw}
def synop_imgw_reduced():
    try:data=get_json('https://danepubliczne.imgw.pl/api/data/synop')
    except:return None
    x=next((r for r in data if str(r.get('id_stacji'))==SYNOP_ID),None) if isinstance(data,list) else None
    if not x:return None
    d=parse_dt(f"{x.get('data_pomiaru')}T{int(x.get('godzina_pomiaru') or 0):02d}:00:00+00:00")
    return {'source':'IMGW_PUBLIC_SYNOP_REDUCED','station':SYNOP_ID,'wigos':WIGOS_ID,'obs_time':iso(d),'temperature_c':fnum(x.get('temperatura')),'dew_point_c':None,'relative_humidity_pct':fnum(x.get('wilgotnosc_wzgledna')),
      'visibility_m':None,'visibility_lower_bound':None,'visibility_upper_bound':None,'visibility_report':None,'visibility_code_vv':None,'wind_direction_deg':fnum(x.get('kierunek_wiatru')),
      'wind_speed_ms':fnum(x.get('predkosc_wiatru')),'pressure_hpa':fnum(x.get('cisnienie')),'station_pressure_hpa':None,'present_weather_code':None,'present_weather':None,
      'fog':False,'mist':False,'freezing_fog':False,'cloud_base_m_agl':None,'total_cloud_oktas':None,'raw':None}
def get_synop():
    try:
        rows=csv_rows(ogimet('synop',12),SYNOP_ID)
        for t,r in rows:
            x=decode_synop(r,t)
            if x:return x
    except Exception as e:print('SYNOP Ogimet warning:',e)
    return synop_imgw_reduced()

# ---------------- Archive + fusion ----------------
def age(r):
    t=parse_dt((r or {}).get('obs_time')); return 1e9 if not t else max(0,(now()-t).total_seconds()/60)
def newest(rows,key,max_age=150):
    a=[(parse_dt(r.get('obs_time')),r.get(key),r.get('source')) for r in rows if r and r.get(key) is not None and age(r)<=max_age]
    if not a:return None,None
    a.sort(reverse=True,key=lambda z:z[0]);return a[0][1],a[0][2]
def fuse(m,s):
    rows=[x for x in (m,s) if x]
    if not rows:return None
    vis=vsrc=vlb=vub=None
    if s and s.get('visibility_m') is not None and age(s)<=130:vis=s['visibility_m'];vsrc=s['source'];vlb=s.get('visibility_lower_bound');vub=s.get('visibility_upper_bound')
    elif m and m.get('visibility_m') is not None and age(m)<=100:vis=m['visibility_m'];vsrc=m['source'];vlb=m.get('visibility_lower_bound');vub=m.get('visibility_upper_bound')
    T,Tsrc=newest(rows,'temperature_c');Td,Tdsrc=newest(rows,'dew_point_c');RH,RHsrc=newest(rows,'relative_humidity_pct')
    if RH is None:RH=rh(T,Td);RHsrc='derived_T_Td' if RH is not None else None
    wd,wdsrc=newest(rows,'wind_direction_deg');ws,wssrc=newest(rows,'wind_speed_ms');p,psrc=newest(rows,'pressure_hpa')
    cbh,cbhsrc=newest(rows,'cloud_base_m_agl')
    if cbh is None:cbh,cbhsrc=newest(rows,'ceiling_m_agl')
    times=[parse_dt(r.get('obs_time')) for r in rows];times=[x for x in times if x]
    return {'obs_time':iso(max(times)) if times else None,'temperature_c':rnd(T,1),'dew_point_c':rnd(Td,1),'relative_humidity_pct':rnd(RH,1),'visibility_m':rnd(vis,0),
      'visibility_lower_bound':vlb,'visibility_upper_bound':vub,'visibility_source':vsrc,'wind_direction_deg':rnd(wd,0),'wind_speed_ms':rnd(ws,2),'pressure_hpa':rnd(p,1),'cloud_base_m_agl':rnd(cbh,0),
      'fog':bool((m and m.get('fog')) or (s and s.get('fog'))),'mist':bool((m and m.get('mist')) or (s and s.get('mist'))),'freezing_fog':bool((m and m.get('freezing_fog')) or (s and s.get('freezing_fog'))),
      'sources':{'temperature':Tsrc,'dew_point':Tdsrc,'rh':RHsrc,'visibility':vsrc,'wind_direction':wdsrc,'wind_speed':wssrc,'pressure':psrc,'cloud_base':cbhsrc}}
def key(r):return (r.get('source'),r.get('station'),r.get('obs_time'),r.get('raw') or r.get('visibility_report'))
def append(path,r):
    if not r or not r.get('obs_time'):return False
    path.parent.mkdir(parents=True,exist_ok=True);k=key(r)
    if path.exists():
        for line in path.read_text(encoding='utf-8').splitlines():
            try:
                if key(json.loads(line))==k:return False
            except:pass
    with path.open('a',encoding='utf-8') as f:f.write(json.dumps(r,ensure_ascii=False,separators=(',',':'))+'\n')
    return True
def recent(kind,h=30):
    cut=now()-timedelta(hours=h);a=[]
    for p in sorted((OUT/kind).glob('*.jsonl'))[-3:]:
        for line in p.read_text(encoding='utf-8').splitlines():
            try:
                r=json.loads(line);t=parse_dt(r.get('obs_time'))
                if t and t>=cut:a.append(r)
            except:pass
    return sorted(a,key=lambda r:parse_dt(r.get('obs_time')) or datetime(1970,1,1,tzinfo=timezone.utc))
def nearest(rows,t,mins=40):
    a=[(abs((parse_dt(r.get('obs_time'))-t).total_seconds()),r) for r in rows if parse_dt(r.get('obs_time'))]
    if not a:return None
    d,r=min(a,key=lambda z:z[0]);return r if d<=mins*60 else None
def history(ms,ss):
    out=[];used=set()
    for s in ss:
        t=parse_dt(s.get('obs_time'));m=nearest(ms,t) if t else None
        if m:used.add(key(m))
        z=fuse(m,s)
        if z:z['metar_obs_time']=m.get('obs_time') if m else None;z['synop_obs_time']=s.get('obs_time');out.append(z)
    for m in ms:
        if key(m) in used:continue
        z=fuse(m,None)
        if z:z['metar_obs_time']=m.get('obs_time');z['synop_obs_time']=None;out.append(z)
    return sorted(out,key=lambda z:parse_dt(z.get('obs_time')) or datetime(1970,1,1,tzinfo=timezone.utc))[-100:]
def write(path,obj,pretty=False):
    text=(json.dumps(obj,ensure_ascii=False,indent=2,sort_keys=True) if pretty else json.dumps(obj,ensure_ascii=False,separators=(',',':')))+'\n'
    old=path.read_text(encoding='utf-8') if path.exists() else None
    if old==text:return False
    path.parent.mkdir(parents=True,exist_ok=True);path.write_text(text,encoding='utf-8');return True

def main():
    OUT.mkdir(parents=True,exist_ok=True);m=get_metar();s=get_synop()
    if not m and not s:raise SystemExit('No EPIR METAR or SYNOP 12342 data available')
    changed=False
    for kind,r in (('metar',m),('synop',s)):
        if r and r.get('obs_time'):changed|=append(OUT/kind/(parse_dt(r['obs_time']).strftime('%Y-%m-%d')+'.jsonl'),r)
    ms,ss=recent('metar'),recent('synop');hist=history(ms,ss);f=hist[-1] if hist else fuse(m,s)
    st={'icao':ICAO,'synop':SYNOP_ID,'wigos':WIGOS_ID,'lat':LAT,'lon':LON}
    latest={'schema':'epir-observation-latest-v2','station':st,'updated_at':f.get('obs_time') if f else (m or s).get('obs_time'),'collected_at':iso(now()),'metar':m,'synop':s,'fused':f}
    rec={'schema':'epir-observation-history-v2','station':st,'hours':30,'metar':ms,'synop':ss,'observations':hist}
    changed|=write(OUT/'latest.json',latest,True);changed|=write(OUT/'recent.json',rec)
    print(json.dumps({'changed':changed,'metar_source':m.get('source') if m else None,'metar_time':m.get('obs_time') if m else None,'metar_raw':m.get('raw') if m else None,
      'synop_source':s.get('source') if s else None,'synop_time':s.get('obs_time') if s else None,'synop_raw':s.get('raw') if s else None,'synop_visibility_m':s.get('visibility_m') if s else None,
      'fused_visibility_m':f.get('visibility_m') if f else None,'fused_visibility_source':f.get('visibility_source') if f else None},ensure_ascii=False))
if __name__=='__main__':main()
