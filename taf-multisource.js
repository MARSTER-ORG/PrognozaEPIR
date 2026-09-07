'use strict';
(() => {
  const VERSION = 'TAF Sources v0.3.1';
  const IDS = ['EPIR','EPBY','EPPW','EPKS'];
  const IMGW_URL = 'https://awiacja.imgw.pl/metar-i-taf';
  const AWC_TAF = 'https://aviationweather.gov/api/data/taf?ids=EPIR%2CEPBY%2CEPPW%2CEPKS&format=raw';
  const MANUAL_KEY = 'prognozaepir-manual-tafs';
  const PROXY_KEY = 'prognozaepir-taf-proxy-url';
  const DEFAULT_PROXY_URL = 'https://prognozaepir-taf-proxy-matmobilny-9204.vercel.app/api/taf-proxy';
  const nativeFetch = window.fetch.bind(window);
  let lastBundle = null;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function plainHtml(htmlText){
    const d = new DOMParser().parseFromString(String(htmlText||''),'text/html');
    d.querySelectorAll('script,style,noscript').forEach(x=>x.remove());
    return (d.body?.innerText||d.documentElement?.textContent||'').replace(/\s+/g,' ').trim();
  }

  function reports(text){
    const one = String(text||'').replace(/\s+/g,' ').trim();
    const re = /\bTAF(?:\s+(?:AMD|COR))?\s+(EPIR|EPBY|EPPW|EPKS)\b[\s\S]*?(?==|(?=\bTAF(?:\s+(?:AMD|COR))?\s+(?:EPIR|EPBY|EPPW|EPKS)\b)|$)/gi;
    const out=[]; let m;
    while((m=re.exec(one))){
      let raw=m[0].replace(/\s+/g,' ').trim();
      if(raw&&!raw.endsWith('=')) raw+='=';
      out.push({id:m[1].toUpperCase(),raw});
    }
    return out;
  }

  function isMetarEpir(raw){
    const s=String(raw||'').replace(/\s+/g,' ').trim();
    if(!/\bEPIR\s+\d{6}Z\b/i.test(s)) return false;
    if(/\bTAF\b/i.test(s)||/\b\d{4}\/\d{4}\b/.test(s)) return false;
    if(/\b(?:BECMG|TEMPO|PROB30|PROB40|FM\d{6})\b/i.test(s)) return false;
    const wind=/\b(?:\d{3}|VRB)\d{2,3}(?:G\d{2,3})?KT\b/i.test(s);
    const vis=/\bCAVOK\b/i.test(s)||/\b(?:9999|\d{4})\b/.test(s);
    return wind&&vis;
  }

  function metars(text){
    const one=String(text||'').replace(/\s+/g,' ').trim();
    const re=/\b(?:METAR|SPECI)?\s*EPIR\s+\d{6}Z\b[\s\S]*?(?==|(?=\b(?:METAR|SPECI|TAF)\b)|$)/gi;
    const out=[]; let m;
    while((m=re.exec(one))){let raw=m[0].replace(/\s+/g,' ').trim();if(raw&&!raw.endsWith('='))raw+='=';if(isMetarEpir(raw))out.push(raw)}
    return out;
  }

  function resolve(code, ref=Date.now(), minutes=false){
    if(!/^\d{4,6}$/.test(code)) return null;
    const day=+code.slice(0,2), hour=+code.slice(2,4), minute=minutes?+code.slice(4,6):0, r=new Date(ref);
    let best=null, bd=Infinity;
    for(let dm=-1;dm<=1;dm++){
      const t=Date.UTC(r.getUTCFullYear(),r.getUTCMonth()+dm,day,hour,minute), d=Math.abs(t-ref);
      if(d<bd){bd=d;best=t}
    }
    return best;
  }

  function info(raw){
    const s=String(raw||'').replace(/\s+/g,' ').trim();
    const sm=s.match(/\bTAF(?:\s+(?:AMD|COR))?\s+(EPIR|EPBY|EPPW|EPKS)\b/i), im=s.match(/\b(\d{6})Z\b/), vm=s.match(/\b(\d{4})\/(\d{4})\b/);
    if(!sm||!im) return null;
    const issue=resolve(im[1],Date.now(),true); let vs=null,ve=null;
    if(vm){vs=resolve(vm[1],issue,false);ve=resolve(vm[2],vs+6*3600e3,false);if(ve<=vs)ve=resolve(vm[2],vs+18*3600e3,false)}
    const nil=/\bNIL\b/.test(s), age=(Date.now()-issue)/3600e3;
    return {id:sm[1].toUpperCase(),raw:s.endsWith('=')?s:s+'=',issue,vs,ve,nil,current:age>=-1.5&&age<=8.5&&(nil||ve==null||ve>Date.now()-3600e3)};
  }

  function rank(c){if(c.manual)return 100;if(/IMGW/i.test(c.source))return 80;if(/PilotHub/i.test(c.source))return 70;if(/AWC/i.test(c.source))return 60;if(/cache/i.test(c.source))return 10;return 20}
  function add(store,id,raw,source,url='',manual=false,confirmed=[]){const x=info(raw);if(!x||x.id!==id)return;store[id].push({...x,source,url,manual,confirmed})}
  function select(list){return [...list].sort((a,b)=>a.current!==b.current?(a.current?-1:1):a.manual!==b.manual?(a.manual?-1:1):b.issue!==a.issue?b.issue-a.issue:rank(b)-rank(a))[0]||null}

  function timeoutFetch(url,opts={},ms=7000){
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),ms);
    return nativeFetch(url,{...opts,signal:ctl.signal}).finally(()=>clearTimeout(timer));
  }

  async function fromProxy(store,metar,attempts){
    let urls=[];try{const x=localStorage.getItem(PROXY_KEY);if(x)urls.push(x)}catch(_){ }
    urls.push(DEFAULT_PROXY_URL);
    if(!location.hostname.includes('github.io')) urls.push('/api/taf-proxy');
    urls=[...new Set(urls)];
    for(const url of urls){
      try{
        const r=await timeoutFetch(url+(url.includes('?')?'&':'?')+'_='+Date.now(),{cache:'no-store'},12000);if(!r.ok)throw Error('HTTP '+r.status);
        const j=await r.json();let n=0;
        for(const id of IDS){const x=j?.stations?.[id];if(x?.raw){add(store,id,x.raw,`Proxy · ${x.source||'multi-source'}`,x.source_url||url,false,x.confirmed_by||[]);n++}}
        if(j?.metar_epir?.raw&&isMetarEpir(j.metar_epir.raw)) metar.push({raw:j.metar_epir.raw,source:`Proxy · ${j.metar_epir.source||'multi-source'}`,t:Date.parse(j.metar_epir.obs_time||0)||0});
        attempts.push(`proxy ${n}/4`);if(n)return;
      }catch(e){attempts.push('proxy × '+(e?.name==='AbortError'?'timeout':e.message))}
    }
  }

  async function fromImgw(store,metar,attempts){
    try{
      const r=await timeoutFetch(IMGW_URL+'?_='+Date.now(),{cache:'no-store',mode:'cors',headers:{Accept:'text/html'}},8000);if(!r.ok)throw Error('HTTP '+r.status);
      const text=plainHtml(await r.text());let n=0;
      for(const x of reports(text)){add(store,x.id,x.raw,'IMGW direct',IMGW_URL);n++}
      for(const raw of metars(text)){const m=raw.match(/\b(\d{6})Z\b/);metar.push({raw,source:'IMGW direct',t:m?resolve(m[1],Date.now(),true):0})}
      attempts.push(`IMGW ${n}/4`);
    }catch(e){attempts.push('IMGW × '+(e?.name==='AbortError'?'timeout':e.message))}
  }

  async function fromAwc(store,attempts){
    try{
      const r=await timeoutFetch(AWC_TAF,{cache:'no-store'},7000);if(!r.ok)throw Error('HTTP '+r.status);
      const text=await r.text();let n=0;for(const x of reports(text)){add(store,x.id,x.raw,'AWC direct','https://aviationweather.gov/api/data/taf');n++}
      attempts.push(`AWC ${n}/4`);
    }catch(e){attempts.push('AWC × '+(e?.name==='AbortError'?'timeout':e.message))}
  }

  async function fromCache(store,attempts){
    try{
      const r=await nativeFetch('data/taf/neighbors.json?_='+Date.now(),{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);const j=await r.json();let n=0;
      for(const id of IDS){const x=j?.stations?.[id];if(x?.raw){add(store,id,x.raw,`cache · ${x.source||'repo'}`,x.source_url||'data/taf/neighbors.json');n++}}
      attempts.push(`cache ${n}/4`);
    }catch(e){attempts.push('cache × '+e.message)}
  }

  function fromManual(store,attempts){
    let text='';try{text=localStorage.getItem(MANUAL_KEY)||''}catch(_){ }
    let n=0;for(const x of reports(text)){add(store,x.id,x.raw,'RĘCZNY','',true);n++}
    if(n)attempts.push(`ręczne ${n}/4`);
  }

  async function collect(){
    const store=Object.fromEntries(IDS.map(id=>[id,[]])), metar=[], attempts=[];
    fromManual(store,attempts);
    await Promise.allSettled([fromProxy(store,metar,attempts),fromImgw(store,metar,attempts),fromAwc(store,attempts),fromCache(store,attempts)]);
    const stations={};for(const id of IDS)stations[id]=select(store[id]);
    metar.sort((a,b)=>b.t-a.t);
    return {stations,metar:metar[0]||null,attempts,updated:Date.now()};
  }

  function synthetic(bundle){
    const lines=[];
    if(bundle.metar?.raw&&isMetarEpir(bundle.metar.raw)){
      const mr=String(bundle.metar.raw).trim();
      lines.push(/^(?:METAR|SPECI)\b/i.test(mr)?mr:'METAR '+mr);
    }
    for(const id of IDS){const x=bundle.stations[id];if(!x)continue;if(id!=='EPIR'&&x.nil)continue;lines.push(x.raw)}
    return '<!doctype html><html><body><pre>'+esc(lines.join('\n'))+'</pre></body></html>';
  }

  function status(x){return !x?'BRAK':x.current?(x.nil?'AKTUALNY NIL':'AKTUALNY'):'STARY CYKL'}
  function renderSources(bundle){
    lastBundle=bundle;const body=document.getElementById('tafSourceRows'),meta=document.getElementById('tafSourceMeta');if(!body||!meta)return;
    body.innerHTML=IDS.map(id=>{const x=bundle.stations[id];return `<tr><td><b>${id}</b></td><td class="${x?.current?'ok':x?'warn':'bad'}">${status(x)}</td><td>${esc(x?.source||'—')}${x?.confirmed?.length?' · '+esc(x.confirmed.join('+')):''}</td><td>${esc(x?.raw||'brak')}</td></tr>`}).join('');
    meta.textContent=`${VERSION} · ${bundle.attempts.join(' · ')}`;
    const pill=[...document.querySelectorAll('#sources .pill')].find(x=>x.textContent.includes('TAF IMGW live'));if(pill){const n=IDS.filter(id=>bundle.stations[id]?.current).length;pill.textContent=`TAF multi-source ${n}/4 ${n?'✓':'×'}`;pill.className='pill '+(n?'ok':'warn')}
  }

  async function intercepted(input,init){
    const url=typeof input==='string'?input:input?.url||'';
    if(!url.startsWith(IMGW_URL)) return nativeFetch(input,init);
    try{const b=await collect();renderSources(b);return new Response(synthetic(b),{status:200,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}})}
    catch(e){return nativeFetch(input,init)}
  }

  function inject(){
    const grid=document.querySelector('.grid');if(!grid||document.getElementById('tafMultiSourcePanel'))return;
    const project=[...grid.querySelectorAll('.card')].find(x=>x.querySelector('#taf'));
    const sec=document.createElement('section');sec.id='tafMultiSourcePanel';sec.className='card w12';sec.innerHTML=`<h2>TAF źródłowe / ręczne</h2><div class="note">Pobierane dopiero po kliknięciu „Odśwież i generuj”. Kolejność: ręczne → najświeższe z proxy/IMGW/AWC/PilotHub → cache. TAF EPIR jest tylko referencją i nie steruje projektem.</div><textarea id="manualTafInput" style="width:100%;min-height:85px;margin-top:7px;border:1px solid var(--b);border-radius:6px;background:var(--s2);color:var(--fg);padding:7px;font:11px/1.4 ui-monospace,Consolas,monospace" placeholder="TAF EPIR ...=\nTAF EPBY ...=\nTAF EPPW ...=\nTAF EPKS ...="></textarea><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><button id="manualTafSave">Zapisz ręczne TAF-y</button><button id="manualTafClear">Wyczyść ręczne</button></div><details style="margin-top:7px"><summary class="note">Proxy Vercel</summary><div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><input id="tafProxyUrl" type="url" style="flex:1;min-width:260px;border:1px solid var(--b);border-radius:6px;background:var(--s2);color:var(--fg);padding:7px" placeholder="https://prognozaepir-taf-proxy-matmobilny-9204.vercel.app/api/taf-proxy"><button id="tafProxySave">Zapisz</button></div></details><div class="scroll" style="margin-top:8px"><table style="min-width:900px"><thead><tr><th>Stacja</th><th>Status</th><th>Źródło</th><th>TAF</th></tr></thead><tbody id="tafSourceRows"><tr><td colspan="4">Kliknij „Odśwież i generuj”.</td></tr></tbody></table></div><div id="tafSourceMeta" class="note" style="margin-top:5px">${VERSION}</div>`;
    project?.insertAdjacentElement('afterend',sec)||grid.prepend(sec);
    try{document.getElementById('manualTafInput').value=localStorage.getItem(MANUAL_KEY)||'';document.getElementById('tafProxyUrl').value=localStorage.getItem(PROXY_KEY)||DEFAULT_PROXY_URL}catch(_){ }
    document.getElementById('manualTafSave').onclick=()=>{const v=document.getElementById('manualTafInput').value.trim();const n=reports(v).length;if(!n){document.getElementById('tafSourceMeta').textContent='Nie znaleziono TAF EPIR/EPBY/EPPW/EPKS.';return}try{localStorage.setItem(MANUAL_KEY,v)}catch(_){}document.getElementById('tafSourceMeta').textContent=`Zapisano ${n} ręcznych TAF. Kliknij „Odśwież i generuj”.`};
    document.getElementById('manualTafClear').onclick=()=>{try{localStorage.removeItem(MANUAL_KEY)}catch(_){}document.getElementById('manualTafInput').value='';document.getElementById('tafSourceMeta').textContent='Ręczne TAF-y wyczyszczone.'};
    document.getElementById('tafProxySave').onclick=()=>{const v=document.getElementById('tafProxyUrl').value.trim();try{if(v)localStorage.setItem(PROXY_KEY,v);else localStorage.removeItem(PROXY_KEY)}catch(_){}document.getElementById('tafSourceMeta').textContent=v?'Adres proxy zapisany.':'Adres proxy wyczyszczony.'};
    const old=document.querySelector('#neighborSummary');if(old)old.textContent='TAF EPBY / EPPW / EPKS będą używane tylko, gdy wybrany najświeższy cykl jest aktualny.';
  }

  window.fetch=intercepted;
  inject();
  window.PrognozaEPIRTAFSources={version:VERSION,collect:async()=>{const b=await collect();renderSources(b);return b},get last(){return lastBundle}};
})();
