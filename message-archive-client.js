'use strict';
// Supabase-primary-MessageArchive
(() => {
  const SUPABASE_API='https://qozgntzeormujmqzkkmd.supabase.co/functions/v1/message-archive';
  const SUPABASE_ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFvemdudHplb3JtdWptcXpra21kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODkzMjY1ODksImV4cCI6MjEwNDkwMjU4OX0.EV0cw-wlG8cQnFumLwsucxFfURHzlRRZdcusCZow-1o';
  const SUPABASE_ENABLED=window.PROGNOZAEPIR_SUPABASE_DISABLED!==true;
  const GITHUB_ROOT='https://raw.githubusercontent.com/MARSTER-ORG/PrognozaEPIR/main/data/messages';
  const STATIC_ROOT='data/messages';
  const RAILWAY_ROOT='https://central-ingestor-production.up.railway.app/data/messages';
  const CUSTOM_ROOT=window.PROGNOZAEPIR_ARCHIVE_ROOT?String(window.PROGNOZAEPIR_ARCHIVE_ROOT).replace(/\/+$/,''):'';
  const PRIMARY_ROOT=SUPABASE_ENABLED?SUPABASE_API:(CUSTOM_ROOT||RAILWAY_ROOT);
  const TTL_MS=30_000,DAY_MS=86_400_000,MAX_FALLBACK_DAYS=400,cache=new Map(),nativeFetch=window.fetch.bind(window);
  const ARCH_STATIONS=['EPIR','EPBY','EPPW','EPKS'];
  const norm=v=>String(v||'').toUpperCase();
  const allowedTypes=new Set(['METAR','SPECI','TAF','SYNOP']);
  const fallbackRoots=()=>[...new Set([CUSTOM_ROOT,RAILWAY_ROOT,GITHUB_ROOT,STATIC_ROOT].filter(Boolean))];

  async function supabaseRequest(params={},force=false){
    if(!SUPABASE_ENABLED)throw new Error('Supabase MessageArchive disabled');
    const q=new URLSearchParams();
    Object.entries(params).forEach(([k,v])=>{if(v!==undefined&&v!==null&&v!=='')q.set(k,Array.isArray(v)?v.join(','):String(v))});
    const key=`sb:${q}`,now=Date.now(),hit=cache.get(key);if(!force&&hit&&now-hit.at<TTL_MS)return hit.value;
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10_000);
    try{
      const response=await nativeFetch(`${SUPABASE_API}?${q}`,{cache:'no-store',signal:controller.signal,headers:{Accept:'application/json',Authorization:`Bearer ${SUPABASE_ANON}`,apikey:SUPABASE_ANON}});
      if(!response.ok){const text=await response.text().catch(()=>''),e=new Error(`Supabase MessageArchive HTTP ${response.status}${text?`: ${text.slice(0,240)}`:''}`);e.status=response.status;throw e}
      const value=await response.json();if(!value?.ok)throw new Error(value?.error||'Supabase MessageArchive invalid response');cache.set(key,{at:now,value,source:SUPABASE_API});return value;
    }finally{clearTimeout(timer)}
  }

  async function fetchFallback(root,name,asText){
    const c=new AbortController(),timer=setTimeout(()=>c.abort(),8_000);
    try{const r=await nativeFetch(`${root}/${name}?v=${Date.now()}`,{cache:'no-store',signal:c.signal,headers:{Accept:asText?'application/x-ndjson,text/plain,*/*':'application/json'}});if(!r.ok){const e=new Error(`MessageArchive ${name}: HTTP ${r.status}`);e.status=r.status;throw e}return asText?r.text():r.json()}finally{clearTimeout(timer)}
  }
  async function fallback(name,asText,force=false){
    const key=`fallback:${asText?'t':'j'}:${name}`,now=Date.now(),hit=cache.get(key);if(!force&&hit&&now-hit.at<TTL_MS)return hit.value;
    const errors=[];for(const root of fallbackRoots()){try{const value=await fetchFallback(root,name,asText);cache.set(key,{at:now,value,source:root});return value}catch(error){errors.push({root,error})}}
    const e=new Error(`MessageArchive ${name}: źródła zapasowe niedostępne`);e.cause=errors;throw e;
  }
  function daySpec(name){const m=String(name||'').match(/^(metar|speci|taf|synop)\/(\d{4})\/(\d{2})\/(\d{2})\.jsonl$/i);return m?{type:m[1].toUpperCase(),date:`${m[2]}-${m[3]}-${m[4]}`}:null}
  function rowTime(row){for(const k of ['archive_time','message_time','obs_time','issue_time','time','timestamp']){const t=Date.parse(row?.[k]||'');if(Number.isFinite(t))return t}return-Infinity}
  function dedupeSort(rows){const seen=new Set(),out=[];for(const row of rows||[]){if(!row)continue;const key=String(row.message_id||`${norm(row.type||row.report_type)}|${norm(row.station)}|${row.canonical_raw||row.raw||''}`);if(seen.has(key))continue;seen.add(key);out.push(row)}out.sort((a,b)=>rowTime(a)-rowTime(b));return out}
  const newest=rows=>dedupeSort(rows).slice(-1)[0]||null;
  const mergeRows=(...groups)=>dedupeSort(groups.flatMap(x=>Array.isArray(x)?x:[]));
  function dayPath(type,offset=0){const d=new Date(Date.now()-offset*DAY_MS);return dayPathDate(type,d)}
  function dayPathDate(type,date){const d=new Date(date);return `${String(type).toLowerCase()}/${d.getUTCFullYear()}/${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')}.jsonl`}
  function parseJsonl(text,type,station=''){const t=norm(type),s=norm(station),rows=[];for(const line of String(text||'').split(/\r?\n/)){if(!line.trim())continue;try{const r=JSON.parse(line),rt=norm(r?.type||r?.report_type);if(rt&&rt!==t)continue;if(s&&norm(r?.station)!==s)continue;rows.push(r)}catch(_){}}return rows}
  async function fallbackRows(type,station='',force=false,days=2){const t=norm(type);if(!allowedTypes.has(t))return[];const out=[];for(let i=0;i<days;i++){try{out.push(...parseJsonl(await fallback(dayPath(t,i),true,force),t,station))}catch(e){if(e?.status!==404&&i===0)console.warn('MessageArchive fallback:',e)}}return dedupeSort(out)}
  function utcDay(v,defaultMs){const t=Date.parse(v||'');const d=new Date(Number.isFinite(t)?t:defaultMs);d.setUTCHours(0,0,0,0);return d}
  async function fallbackRangeRows(type,station='',from='',to='',limit=5000,force=false){
    const t=norm(type),s=norm(station),n=Math.max(1,Math.min(50000,Number(limit)||5000));if(!allowedTypes.has(t))return[];
    const now=Date.now(),start=utcDay(from,now-DAY_MS),end=utcDay(to,now);if(start>end)return[];
    const out=[],lo=from?Date.parse(from):-Infinity,hi=to?Date.parse(to):Infinity;let days=0;
    for(let ms=start.getTime();ms<=end.getTime()&&days<MAX_FALLBACK_DAYS;ms+=DAY_MS,days++){
      try{out.push(...parseJsonl(await fallback(dayPathDate(t,new Date(ms)),true,force),t,s))}catch(e){if(e?.status!==404)console.warn(`MessageArchive fallback range ${t} ${dayPathDate(t,new Date(ms))}:`,e)}
    }
    return dedupeSort(out).filter(r=>{const x=rowTime(r);return x>=lo&&x<=hi}).slice(0,n);
  }

  function rawOf(r){return String(r?.canonical_raw||r?.raw||r?.message||r?.text||'').replace(/\s+/g,' ').trim()}
  function numericMetric(r,key){
    const direct=Number(r?.[key]);if(Number.isFinite(direct))return direct;
    if(key==='wind_speed_kt'){const x=Number(r?.wind_speed_ms);return Number.isFinite(x)?x*1.9438444924406:null}
    if(key==='gust_kt'){const x=Number(r?.wind_gust_ms);return Number.isFinite(x)?x*1.9438444924406:null}
    if(key==='ceiling_ft'){const x=Number(r?.ceiling_m_agl);return Number.isFinite(x)?x*3.2808398950131:null}
    if(key==='qnh_hpa'){const x=Number(r?.pressure_hpa);return Number.isFinite(x)?x:null}
    return null;
  }
  function weatherFlags(r){
    const raw=rawOf(r).toUpperCase(),codes=new Set(Array.isArray(r?.weather_codes)?r.weather_codes.map(norm):[]),tests={FG:/(^|\s)[+-]?(FZ)?FG(\s|=|$)/,BR:/(^|\s)[+-]?BR(\s|=|$)/,MIFG:/(^|\s)MIFG(\s|=|$)/,TS:/(^|\s)[+-]?(VC)?TS[A-Z]*(\s|=|$)/,RA:/(^|\s)[+-]?[A-Z]*RA[A-Z]*(\s|=|$)/,SN:/(^|\s)[+-]?[A-Z]*SN[A-Z]*(\s|=|$)/,CB:/(FEW|SCT|BKN|OVC)\d{3}CB\b/,TCU:/(FEW|SCT|BKN|OVC)\d{3}TCU\b/,VV:/(^|\s)VV(\d{3}|\/\/\/)/};
    Object.entries(tests).forEach(([k,re])=>{if(re.test(raw))codes.add(k)});return codes;
  }
  function localMatches(r,f){
    const station=norm(r?.station),raw=rawOf(r).toUpperCase();if(f.station&&station!==norm(f.station))return false;
    if(f.text){const toks=String(f.text).toUpperCase().split(/\s*\+\s*|\s+/).filter(Boolean);if(toks.some(t=>!raw.includes(t)))return false}
    const checks=[['visibility_min','visibility_m','min'],['visibility_max','visibility_m','max'],['ceiling_min_ft','ceiling_ft','min'],['ceiling_max_ft','ceiling_ft','max'],['wind_speed_min_kt','wind_speed_kt','min'],['wind_speed_max_kt','wind_speed_kt','max'],['gust_min_kt','gust_kt','min'],['gust_max_kt','gust_kt','max'],['temp_min_c','temperature_c','min'],['temp_max_c','temperature_c','max'],['qnh_min','qnh_hpa','min'],['qnh_max','qnh_hpa','max']];
    for(const[p,k,kind]of checks){if(f[p]===undefined||f[p]===null||f[p]==='')continue;const x=numericMetric(r,k),v=Number(f[p]);if(x===null||!Number.isFinite(v)||(kind==='min'?x<v:x>v))return false}
    const dir=Number(r?.wind_direction_deg),df=Number(f.wind_dir_from),dt=Number(f.wind_dir_to);if(f.wind_dir_from!==undefined&&f.wind_dir_from!==''&&Number.isFinite(df)){if(!Number.isFinite(dir))return false;if(f.wind_dir_to!==undefined&&f.wind_dir_to!==''&&Number.isFinite(dt)){if(df<=dt?(dir<df||dir>dt):(dir<df&&dir>dt))return false}else if(dir<df)return false}else if(f.wind_dir_to!==undefined&&f.wind_dir_to!==''&&Number.isFinite(dt)){if(!Number.isFinite(dir)||dir>dt)return false}
    if(f.flags){const codes=weatherFlags(r);for(const flag of String(f.flags).toUpperCase().split(',').map(x=>x.trim()).filter(Boolean))if(!codes.has(flag))return false}
    return true;
  }
  async function fallbackSearch(filters={},force=false){
    const types=(Array.isArray(filters.types)?filters.types:String(filters.type||'').split(',')).map(norm).filter(t=>allowedTypes.has(t));const wanted=types.length?types:[...allowedTypes],all=[];
    for(const type of wanted)all.push(...await fallbackRangeRows(type,filters.station||'',filters.from||'',filters.to||'',50000,force));
    let rows=dedupeSort(all).filter(r=>localMatches(r,filters));if(String(filters.sort||'desc').toLowerCase()!=='asc')rows.reverse();
    const count=rows.length,offset=Math.max(0,Number(filters.offset)||0),limit=Math.max(1,Math.min(5000,Number(filters.limit)||500));
    return{ok:true,schema:'prognozaepir-message-archive-search-fallback-v3',rows:rows.slice(offset,offset+limit),count,offset,limit,fallback:true};
  }

  async function fetchText(name,force=false){const clean=String(name||'').replace(/^\/+/, '');if(!clean||clean.includes('..')||!/^[A-Za-z0-9._/-]+$/.test(clean))throw new Error('MessageArchive: invalid archive path');const spec=daySpec(clean);if(spec&&SUPABASE_ENABLED){try{const r=await supabaseRequest({op:'day',type:spec.type,date:spec.date,limit:5000},force);return (r.rows||[]).map(x=>JSON.stringify(x)).join('\n')+((r.rows||[]).length?'\n':'')}catch(e){console.warn('MessageArchive Supabase day:',e)}}return fallback(clean,true,force)}
  async function latest(force=false){try{return (await supabaseRequest({op:'latest'},force)).data||{}}catch(e){console.warn('MessageArchive Supabase latest:',e);return fallback('latest.json',false,force)}}
  async function recent(force=false){try{const defs=[['METAR','EPIR'],['SPECI','EPIR'],['TAF','EPIR'],['SYNOP','12342']],rs=await Promise.all(defs.map(([type,station])=>supabaseRequest({op:'recent',type,station,limit:500},force)));const metar=rs[0].rows||[],speci=rs[1].rows||[];return{schema:'prognozaepir-message-archive-recent-v3',metar_only:metar,metar,speci,aviation:mergeRows(metar,speci),taf:rs[2].rows||[],synop:rs[3].rows||[]}}catch(e){console.warn('MessageArchive Supabase recent:',e);return fallback('recent.json',false,force)}}
  async function status(force=false){try{return (await supabaseRequest({op:'status'},force)).status||{}}catch(e){console.warn('MessageArchive Supabase status:',e);return fallback('status.json',false,force)}}
  async function getLatest(type,station='',force=false){const t=norm(type),s=norm(station);if(t==='AVIATION'){const[m,sp]=await Promise.all([getLatest('METAR',s||'EPIR',force),getLatest('SPECI',s||'EPIR',force)]);return newest([m,sp])}try{return (await supabaseRequest({op:'latest',type:t,station:s},force)).row||null}catch(e){console.warn(`MessageArchive latest ${t}:`,e);return newest(await fallbackRows(t,s,force,2))}}
  async function getRecent(type,station='',limit=0,force=false){const t=norm(type),s=norm(station),n=Math.max(0,Number(limit)||0);if(t==='AVIATION'){const[m,sp]=await Promise.all([getRecent('METAR',s||'EPIR',n,force),getRecent('SPECI',s||'EPIR',n,force)]),r=mergeRows(m,sp);return n?r.slice(-n):r}try{return (await supabaseRequest({op:'recent',type:t,station:s,limit:n||500},force)).rows||[]}catch(e){console.warn(`MessageArchive recent ${t}:`,e);const r=await fallbackRows(t,s,force,2);return n?r.slice(-n):r}}
  async function getRange(type,station='',from='',to='',limit=5000,force=false){const t=norm(type),n=Math.max(1,Math.min(5000,Number(limit)||5000));try{return (await supabaseRequest({op:'range',type:t,station:norm(station),from,to,limit:n},force)).rows||[]}catch(e){console.warn(`MessageArchive range ${t} -> fallback:`,e);return fallbackRangeRows(t,station,from,to,n,force)}}
  async function search(filters={},force=false){const params={op:'search',...filters};if(Array.isArray(params.types))params.types=params.types.map(norm).filter(t=>allowedTypes.has(t));if(params.type)params.type=norm(params.type);if(params.station)params.station=norm(params.station);try{return await supabaseRequest(params,force)}catch(e){console.warn('MessageArchive search -> static fallback:',e);return fallbackSearch(filters,force)}}
  async function stations(force=false){if(/\/arch\.html$/i.test(location.pathname))return ARCH_STATIONS.map(code=>({code,icao:code,wmo:null,name:code}));try{return (await supabaseRequest({op:'stations'},force)).stations||[]}catch(e){console.warn('MessageArchive stations:',e);return ARCH_STATIONS.map(code=>({code,icao:code,wmo:null,name:code}))}}
  async function fetchJson(name,force=false){const clean=String(name||'').replace(/^\/+/, '');if(clean==='latest.json')return latest(force);if(clean==='recent.json')return recent(force);if(clean==='status.json')return status(force);return fallback(clean,false,force)}

  const api=Object.freeze({root:PRIMARY_ROOT,liveRoot:PRIMARY_ROOT,supabaseRoot:SUPABASE_API,railwayRoot:RAILWAY_ROOT,githubRoot:GITHUB_ROOT,fallbackRoot:STATIC_ROOT,staticFallbackRoot:STATIC_ROOT,latest,recent,status,getLatest,getRecent,getRange,search,stations,fetchText,fetchJson,sourceFor(name){return cache.get(name)?.source||cache.get(`fallback:t:${name}`)?.source||cache.get(`fallback:j:${name}`)?.source||null},clear(){cache.clear()}});
  window.PrognozaEPIRMessageArchive=api;

  function installArchStationSelector(){
    if(!/\/arch\.html$/i.test(location.pathname))return;const old=document.getElementById('station');if(!old)return;
    if(old.tagName==='SELECT'){if(!old.value)old.value='EPIR';return}
    const select=document.createElement('select');select.id='station';select.setAttribute('aria-label','Stacja');
    for(const code of ARCH_STATIONS){const option=document.createElement('option');option.value=code;option.textContent=code;if(code==='EPIR')option.selected=true;select.appendChild(option)}
    old.replaceWith(select);select.addEventListener('change',()=>{const summary=document.getElementById('summary');if(summary)summary.textContent='Filtry zmienione — naciśnij SZUKAJ.'});
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',installArchStationSelector,{once:true});else installArchStationSelector();

  const legacy=input=>{try{const raw=typeof input==='string'?input:input?.url,u=new URL(raw,location.href);if(u.origin!==location.origin)return null;let m=u.pathname.match(/\/data\/messages\/(latest|recent|status)\.json$/i);if(m)return{kind:'json',name:`${m[1].toLowerCase()}.json`};m=u.pathname.match(/\/data\/messages\/((?:metar|speci|taf|synop)\/\d{4}\/\d{2}\/\d{2}\.jsonl)$/i);return m?{kind:'text',name:m[1]}:null}catch(_){return null}};
  window.fetch=async function(input,init){const req=legacy(input);if(!req)return nativeFetch(input,init);try{if(req.kind==='text')return new Response(await fetchText(req.name,true),{status:200,headers:{'Content-Type':'application/x-ndjson; charset=utf-8','Cache-Control':'no-store','X-PrognozaEPIR-Source':'MessageArchive'}});const body=req.name==='latest.json'?await latest(true):req.name==='recent.json'?await recent(true):await status(true);return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-PrognozaEPIR-Source':'MessageArchive'}})}catch(e){console.warn(`MessageArchive legacy bridge ${req.name}:`,e);return nativeFetch(input,init)}};

  window.dispatchEvent(new CustomEvent('prognozaepir:message-archive-ready'));
  if(/\/taf\.html$/i.test(location.pathname)){
    const sig=p=>[p?.aviation?.message_id||p?.metar?.message_id||'',p?.speci?.message_id||'',p?.taf_by_station?.EPIR?.message_id||p?.taf?.message_id||'',p?.taf_by_station?.EPBY?.message_id||'',p?.taf_by_station?.EPPW?.message_id||'',p?.taf_by_station?.EPKS?.message_id||''].join('|');let last=null;
    const trigger=()=>{if(document.visibilityState==='hidden')return false;const b=document.getElementById('gen'),badge=document.getElementById('badge');if(!b||typeof b.click!=='function'||String(badge?.textContent||'').toUpperCase().includes('ŁADOWANIE'))return false;b.click();return true};
    const check=async(initial=false)=>{try{const p=await latest(true),s=sig(p);if(last===null){last=s;if(initial)trigger();return}if(s!==last&&trigger())last=s}catch(e){console.warn('TAF archive freshness watcher:',e)}};
    window.addEventListener('load',()=>{setTimeout(()=>check(true),250);setInterval(()=>{if(document.visibilityState!=='hidden')check(false)},60_000)},{once:true});document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='hidden')check(false)});
  }
})();