'use strict';
(() => {
  const ROOT = 'data/messages';
  const TTL_MS = 30_000;
  const LIVE_TTL_MS = 20_000;
  const LIVE_IMGW = 'https://aviation-api.imgw.pl/data/last?params=metar,taf&format=json&count=4';
  const TAF_STATIONS = new Set(['EPIR','EPBY','EPPW','EPKS']);
  const cache = new Map();
  let liveCache = null;

  async function fetchJson(name, force=false){
    const now=Date.now(), hit=cache.get(name);
    if(!force && hit && now-hit.at < TTL_MS) return hit.value;
    const ctl=new AbortController(), timer=setTimeout(()=>ctl.abort(),5000);
    try{
      const url=`${ROOT}/${name}?v=${now}`;
      const r=await fetch(url,{cache:'no-store',signal:ctl.signal});
      if(!r.ok) throw new Error(`Archive ${name}: HTTP ${r.status}`);
      const value=await r.json();
      cache.set(name,{at:now,value});
      return value;
    } finally { clearTimeout(timer); }
  }

  const norm = v => String(v||'').toUpperCase();
  const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
  const finite = Number.isFinite;

  function walkMessages(value, out=[]){
    if(Array.isArray(value)) for(const child of value) walkMessages(child,out);
    else if(value && typeof value==='object'){
      if(typeof value.message==='string') out.push(value.message);
      for(const child of Object.values(value)) walkMessages(child,out);
    }
    return out;
  }

  function bulletinTime(raw){
    const m=String(raw||'').match(/\b(\d{2})(\d{2})(\d{2})Z\b/);
    if(!m) return 0;
    const day=Number(m[1]), hour=Number(m[2]), minute=Number(m[3]), now=new Date();
    let best=0, delta=Infinity;
    for(const dm of [-1,0,1]){
      const base=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()+dm,1,0,0,0));
      const y=base.getUTCFullYear(), mo=base.getUTCMonth();
      const d=new Date(Date.UTC(y,mo,day,hour,minute,0));
      if(d.getUTCFullYear()!==y || d.getUTCMonth()!==mo || d.getUTCDate()!==day) continue;
      const q=Math.abs(d.getTime()-now.getTime());
      if(q<delta){delta=q;best=d.getTime();}
    }
    return best;
  }

  function isoTime(ms){ return ms ? new Date(ms).toISOString().replace('.000Z','Z') : null; }
  function tempToken(v){ if(v==null)return null; return /^M/.test(v)?-Number(v.slice(1)):Number(v); }
  function rh(t,td){
    if(!finite(t)||!finite(td))return null;
    const a=17.625,b=243.04;
    return Math.max(0,Math.min(100,100*Math.exp(a*td/(b+td)-a*t/(b+t))));
  }

  function parseLiveMetar(message){
    let text=String(message||'').replace(/\s+/g,' ').trim();
    const explicit=(text.match(/^(METAR|SPECI)\s+/i)||[])[1];
    const reportType=norm(explicit)==='SPECI'?'SPECI':'METAR';
    text=text.replace(/^(METAR|SPECI)\s+/i,'').trim().replace(/\s*=\s*$/,'');
    if(!/^EPIR\b/i.test(text)) return null;
    const stamp=bulletinTime(text); if(!stamp)return null;
    const wind=text.match(/\b(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\b/i);
    const temp=text.match(/\b(M?\d{2})\/(M?\d{2})\b/);
    const press=text.match(/\bQ(\d{4})\b/i);
    let vis=null,visReport=null,visLower=false;
    if(/\bCAVOK\b/i.test(text)){vis=10000;visReport='CAVOK';visLower=true;}
    else {
      const vm=text.match(/(?:^|\s)(\d{4})(?=\s|$)/);
      if(vm){visReport=vm[1];vis=vm[1]==='9999'?10000:Number(vm[1]);visLower=vm[1]==='9999';}
    }
    const clouds=[];
    for(const m of text.matchAll(/\b(FEW|SCT|BKN|OVC|VV)(\d{3})(?:\/\/\/|CB|TCU)?\b/gi)){
      const ft=Number(m[2])*100;
      clouds.push({cover:norm(m[1]),base_ft_agl:ft,base_m_agl:Math.round(ft*0.3048)});
    }
    const ceiling=clouds.find(c=>['BKN','OVC','VV'].includes(c.cover))?.base_m_agl??null;
    const t=temp?tempToken(temp[1]):null, td=temp?tempToken(temp[2]):null;
    const wx=[...text.matchAll(/(?:^|\s)(FZFG|MIFG|BCFG|PRFG|FG|BR)(?=\s|$)/gi)].map(m=>norm(m[1]));
    return {
      schema:'prognozaepir-message-v1',type:reportType,report_type:reportType,station:'EPIR',
      raw:text,canonical_raw:`${reportType} ${text}=`,obs_time:isoTime(stamp),message_time:isoTime(stamp),
      source:'IMGW_AVIATION_API_LIVE',sources:[{name:'IMGW Aviation API LIVE',url:LIVE_IMGW}],live_fallback:true,
      temperature_c:t,dew_point_c:td,relative_humidity_pct:finite(rh(t,td))?Math.round(rh(t,td)*10)/10:null,
      visibility_m:vis,visibility_report:visReport,visibility_lower_bound:visLower,visibility_upper_bound:false,
      wind_direction_deg:wind&&wind[1]!=='VRB'?Number(wind[1]):null,
      wind_speed_ms:wind?Math.round(Number(wind[2])*0.514444*100)/100:null,
      wind_gust_ms:wind&&wind[3]?Math.round(Number(wind[3])*0.514444*100)/100:null,
      pressure_hpa:press?Number(press[1]):null,clouds,ceiling_m_agl:ceiling,
      fog:wx.some(x=>x.endsWith('FG')),mist:wx.includes('BR'),freezing_fog:wx.includes('FZFG'),weather:wx.join(' ')||null
    };
  }

  function parseLiveTaf(message){
    let text=String(message||'').replace(/\s+/g,' ').trim();
    const m=text.match(/\bTAF(?:\s+(?:AMD|COR))?\s+(EPIR|EPBY|EPPW|EPKS)\b/i);
    if(!m)return null;
    const station=norm(m[1]); if(!TAF_STATIONS.has(station))return null;
    if(!text.endsWith('='))text+='=';
    const stamp=bulletinTime(text); if(!stamp)return null;
    return {
      schema:'prognozaepir-message-v1',type:'TAF',station,available:true,raw:text,canonical_raw:text,
      issue_time:isoTime(stamp),message_time:isoTime(stamp),source:'IMGW Aviation API LIVE',
      source_url:LIVE_IMGW,sources:[{name:'IMGW Aviation API LIVE',url:LIVE_IMGW}],
      snapshot_only:station!=='EPIR',stale:false,live_fallback:true
    };
  }

  function newer(a,b,keys=['obs_time','message_time']){
    const time=x=>{for(const k of keys){const t=Date.parse(x?.[k]||'');if(finite(t))return t;}return 0;};
    return time(a)>time(b);
  }

  async function fetchLiveImgw(force=false){
    const now=Date.now();
    if(!force && liveCache && now-liveCache.at<LIVE_TTL_MS)return liveCache.value;
    const ctl=new AbortController(), timer=setTimeout(()=>ctl.abort(),4500);
    try{
      const r=await fetch(`${LIVE_IMGW}&_=${now}`,{cache:'no-store',signal:ctl.signal,headers:{'Accept':'application/json'}});
      if(!r.ok)throw new Error(`IMGW live HTTP ${r.status}`);
      const payload=await r.json(), messages=walkMessages(payload), aviation=[], tafs={};
      for(const message of messages){
        if(/\bTAF\b/i.test(message)){
          const row=parseLiveTaf(message); if(!row)continue;
          const old=tafs[row.station];
          if(!old||newer(row,old,['issue_time','message_time']))tafs[row.station]=row;
        } else if(/\bEPIR\s+\d{6}Z\b/i.test(message)){
          const row=parseLiveMetar(message); if(row)aviation.push(row);
        }
      }
      aviation.sort((a,b)=>Date.parse(a.obs_time)-Date.parse(b.obs_time));
      const metars=aviation.filter(x=>x.report_type==='METAR');
      const specis=aviation.filter(x=>x.report_type==='SPECI');
      const value={aviation:aviation.at(-1)||null,metar:metars.at(-1)||null,speci:specis.at(-1)||null,tafs};
      liveCache={at:now,value};
      return value;
    } finally {clearTimeout(timer);}
  }

  function mergeLatest(archive,live){
    const out=clone(archive)||{archive:ROOT,schema:'prognozaepir-message-archive-live-fallback-v1',taf_by_station:{}};
    if(!out.taf_by_station)out.taf_by_station={};
    let used=false;
    if(live?.aviation && newer(live.aviation,out.aviation||out.metar,['obs_time','message_time'])){
      out.aviation=live.aviation; used=true;
      if(live.aviation.report_type==='SPECI')out.speci=live.aviation;
    }
    if(live?.metar && newer(live.metar,out.metar_only||out.metar,['obs_time','message_time'])){
      out.metar=live.metar;out.metar_only=live.metar;used=true;
      if(!out.aviation||newer(live.metar,out.aviation,['obs_time','message_time']))out.aviation=live.metar;
    }
    if(live?.speci && newer(live.speci,out.speci,['obs_time','message_time'])){out.speci=live.speci;used=true;}
    for(const [station,row] of Object.entries(live?.tafs||{})){
      const old=out.taf_by_station[station]||(station==='EPIR'?out.taf:null);
      if(!old||newer(row,old,['issue_time','message_time'])){
        out.taf_by_station[station]=row; if(station==='EPIR')out.taf=row; used=true;
      }
    }
    if(used)out.live_fallback={active:true,source:'IMGW Aviation API',fetched_at:new Date().toISOString()};
    return out;
  }

  function appendUnique(rows,row){
    if(!row)return rows||[];
    const out=Array.isArray(rows)?rows.slice():[];
    const key=x=>`${x?.type||x?.report_type||''}|${x?.station||''}|${x?.message_time||x?.obs_time||x?.issue_time||''}|${x?.raw||''}`;
    if(!out.some(x=>key(x)===key(row)))out.push(row);
    out.sort((a,b)=>Date.parse(a?.message_time||a?.obs_time||a?.issue_time||0)-Date.parse(b?.message_time||b?.obs_time||b?.issue_time||0));
    return out;
  }

  async function latest(force=false){
    let archive=null, archiveError=null;
    try{archive=await fetchJson('latest.json',force);}catch(err){archiveError=err;}
    let live=null;
    if(force||!archive){try{live=await fetchLiveImgw(force);}catch(err){console.warn('IMGW live fallback unavailable:',err);}}
    if(archive)return mergeLatest(archive,live);
    if(live)return mergeLatest(null,live);
    throw archiveError||new Error('MessageArchive and live IMGW unavailable');
  }

  async function recent(force=false){
    const base=await fetchJson('recent.json',force);
    if(!force)return base;
    try{
      const l=await latest(true), out=clone(base)||{};
      out.aviation=appendUnique(out.aviation,l.aviation);
      out.metar=appendUnique(out.metar,l.metar_only||l.metar);
      out.metar_only=appendUnique(out.metar_only,l.metar_only||l.metar);
      out.speci=appendUnique(out.speci,l.speci);
      out.taf=appendUnique(out.taf,l.taf);
      if(l.live_fallback)out.live_fallback=l.live_fallback;
      return out;
    }catch(_){return base;}
  }

  function strictLatest(payload,type,station){
    const t=norm(type), s=norm(station);
    if(t==='METAR'){
      const r=payload?.metar_only||null;
      return !s||norm(r?.station)===s?r:null;
    }
    if(t==='SPECI'){
      const r=payload?.speci||null;
      return !s||norm(r?.station)===s?r:null;
    }
    if(t==='SYNOP'){
      const r=payload?.synop||null;
      return !s||norm(r?.station)===s?r:null;
    }
    if(t==='TAF'){
      if(s) return payload?.taf_by_station?.[s]||null;
      return payload?.taf||null;
    }
    if(t==='AVIATION'){
      const r=payload?.aviation||payload?.metar||null;
      return !s||norm(r?.station)===s?r:null;
    }
    return null;
  }

  function strictRecent(payload,type,station,limit){
    const t=norm(type), s=norm(station);
    let rows=[];
    if(t==='METAR') rows=payload?.metar_only||[];
    else if(t==='SPECI') rows=payload?.speci||[];
    else if(t==='SYNOP') rows=payload?.synop||[];
    else if(t==='TAF') rows=payload?.taf||[];
    else if(t==='AVIATION') rows=payload?.aviation||payload?.metar||[];
    if(s) rows=rows.filter(r=>norm(r?.station)===s);
    if(Number.isFinite(Number(limit))&&Number(limit)>0) rows=rows.slice(-Number(limit));
    return rows;
  }

  const api={
    root:ROOT,
    latest,
    recent,
    status:(force=false)=>fetchJson('status.json',force),
    async getLatest(type,station='',force=false){return strictLatest(await latest(force),type,station)},
    async getRecent(type,station='',limit=0,force=false){return strictRecent(await recent(force),type,station,limit)},
    clear(){cache.clear();liveCache=null;}
  };
  window.PrognozaEPIRMessageArchive=api;
  window.dispatchEvent(new CustomEvent('prognozaepir:message-archive-ready'));
})();
