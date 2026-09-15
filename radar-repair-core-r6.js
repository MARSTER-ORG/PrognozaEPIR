'use strict';

// PrognozaEPIR radar repair v20260914-r6
// 1) restores point-value popups for POLRAD/OPERA,
// 2) keeps manually selected OPERA visible independently of POLRAD sync,
// 3) makes IMGW hazard layer retryable and filters expired warnings.
(() => {
  if (window.__EPIR_RADAR_REPAIR_R6__) return;
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;
  window.__EPIR_RADAR_REPAIR_R6__ = true;

  const $ = id => document.getElementById(id);
  const finite = Number.isFinite;
  const clamp = (v,a,b) => Math.max(a,Math.min(b,v));
  const POLRAD_BOUNDS = L.latLngBounds([[48.5,13.5],[56.0,25.0]]);
  const PROJ_WGS84 = '+proj=longlat +datum=WGS84 +no_defs';
  const SAMPLE_KIND = {cmax:'dbz',cappi:'dbz',sri:'rain',pac:'rain'};
  const SAMPLE_LABEL = {cmax:'POLRAD CMAX',cappi:'POLRAD CAPPI 1 km',sri:'POLRAD SRI',pac:'POLRAD PAC 1 h'};
  const imageCache = new Map();
  let hazardButton=null,hazardLayer=null,hazardLegend=null,hazardGeo=null;

  const style=document.createElement('style');
  style.id='epirRadarRepairR6Style';
  style.textContent='.epir-point-popup{min-width:175px;font-size:12px;line-height:1.35}.epir-point-popup b{font-size:14px}.epir-point-popup .row{margin:2px 0 5px}.epir-point-popup small{color:#666}';
  document.head.appendChild(style);

  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmtUtc=value=>{
    let n=Number(value);if(!finite(n))return'';if(n<1e12)n*=1000;
    const d=new Date(n);return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`;
  };
  const setStatus=text=>{const e=$('polradStatus');if(e)e.textContent=text;};

  // -------------------------------------------------------------------------
  // Point identification
  function hsv(r,g,b){r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;let h=0;if(d){if(mx===r)h=60*(((g-b)/d)%6);else if(mx===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4);}if(h<0)h+=360;return{h,s:mx?d/mx:0,v:mx};}
  function dbzValue(r,g,b,a){if(a<45)return null;const{h,s,v}=hsv(r,g,b);if(s<.28||v<.15)return null;if(h>=225&&h<285){if(v<.30)return 5;if(v<.42)return 8;if(v<.54)return 11;if(v<.66)return 14;if(v<.80)return 17;return 20;}if(h>=195&&h<225)return v<.62?20:v<.82?23:26;if(h>=165&&h<195)return v<.72?26:29;if(h>=105&&h<165)return v<.66?29:v<.84?32:35;if(h>=70&&h<105)return v<.76?35:38;if(h>=48&&h<70)return 38;if(h>=35&&h<48)return 41;if(h>=20&&h<35)return 44;if(h<20||h>=350)return 47;if(h>=285&&h<350)return 50;return null;}
  function rainValue(r,g,b,a){if(a<45)return null;const{h,s,v}=hsv(r,g,b);if(v<.16||s<.18)return null;if(h>=225&&h<285)return v<.45?.1:v<.65?.2:.3;if(h>=190&&h<225)return .6;if(h>=100&&h<190)return 1;if(h>=65&&h<100)return 1.7;if(h>=50&&h<65)return 3.1;if(h>=36&&h<50)return 5.4;if(h>=18&&h<36)return 9.6;if(h<18||h>=350)return 17;if(h>=285&&h<350)return 30;return null;}
  function formatPolrad(v,p){if(!finite(Number(v)))return'brak sygnału';if(SAMPLE_KIND[p]==='dbz')return`~${Math.round(Number(v))} dBZ`;const n=Number(v),u=p==='pac'?'mm':'mm/h';return`${n<1?n.toFixed(1):Math.abs(n-Math.round(n))<.05?Math.round(n):n.toFixed(1)} ${u}`.replace('.',',');}

  function loadImage(src){
    src=String(src||'').replace(/^http:\/\//i,'https://');
    if(!src)return Promise.reject(new Error('brak adresu aktywnego obrazu'));
    if(imageCache.has(src))return imageCache.get(src);
    const p=new Promise((resolve,reject)=>{const im=new Image();im.crossOrigin='anonymous';im.decoding='async';let done=false;const finish=(ok,val)=>{if(done)return;done=true;clearTimeout(timer);ok?resolve(val):reject(val);};const timer=setTimeout(()=>finish(false,new Error('timeout obrazu')),9000);im.onload=()=>finish(true,im);im.onerror=()=>finish(false,new Error('obraz/CORS niedostępny'));im.src=src;});
    imageCache.set(src,p);while(imageCache.size>10)imageCache.delete(imageCache.keys().next().value);return p;
  }

  async function samplePolrad(ll){
    const state=window.PrognozaEPIRPolradState,p=String(state?.product||'').toLowerCase();
    if(!state||!SAMPLE_KIND[p]||!$('polrad_'+p)?.classList.contains('active'))return null;
    const im=await loadImage(state.url),nw=map.latLngToLayerPoint(POLRAD_BOUNDS.getNorthWest()),se=map.latLngToLayerPoint(POLRAD_BOUNDS.getSouthEast()),pt=map.latLngToLayerPoint(ll),fx=(pt.x-nw.x)/(se.x-nw.x),fy=(pt.y-nw.y)/(se.y-nw.y);
    if(fx<0||fy<0||fx>1||fy>1)return{source:SAMPLE_LABEL[p],text:'poza zasięgiem obrazu',time:state.timeMs||state.timeSec};
    const c=document.createElement('canvas');c.width=im.naturalWidth;c.height=im.naturalHeight;const x=c.getContext('2d',{willReadFrequently:true});x.drawImage(im,0,0);const px=Math.round(fx*(c.width-1)),py=Math.round(fy*(c.height-1)),vals=[];
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=clamp(px+dx,0,c.width-1),yy=clamp(py+dy,0,c.height-1),q=x.getImageData(xx,yy,1,1).data,v=SAMPLE_KIND[p]==='dbz'?dbzValue(q[0],q[1],q[2],q[3]):rainValue(q[0],q[1],q[2],q[3]);if(finite(v))vals.push(v);}
    vals.sort((a,b)=>a-b);const v=vals.length?vals[Math.floor(vals.length/2)]:null;
    return{source:SAMPLE_LABEL[p],text:formatPolrad(v,p),time:state.timeMs||state.timeSec,value:v,product:p};
  }

  function median3(values,w,h,x,y){const a=[];for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=clamp(Math.round(x)+dx,0,w-1),yy=clamp(Math.round(y)+dy,0,h-1),v=Number(values[yy*w+xx]);if(finite(v))a.push(v);}a.sort((m,n)=>m-n);return a.length?a[Math.floor(a.length/2)]:NaN;}
  function sampleOpera(ll){
    if(!$('operaCmaxToggle')?.classList.contains('active'))return null;
    const op=window.PrognozaEPIROperaNowcast;if(!op||op.error||!op.latest)return{source:'OPERA Europa CMAX',text:'dane jeszcze się ładują',time:null};
    const r=op.latest.display?.values?op.latest.display:op.latest,pb=r?.projectedBounds,w=Number(r?.width),h=Number(r?.height);
    if(!r?.values||!pb||!finite(w)||!finite(h)||typeof window.proj4!=='function')return{source:'OPERA Europa CMAX',text:'brak rastra punktowego',time:op.latest.time};
    let xy;try{xy=window.proj4(PROJ_WGS84,r.proj,[ll.lng,ll.lat]);}catch(_){return{source:'OPERA Europa CMAX',text:'poza siatką',time:op.latest.time};}
    if(!xy||!xy.every(finite))return{source:'OPERA Europa CMAX',text:'poza siatką',time:op.latest.time};
    const dx=Number(pb.x1)-Number(pb.x0),dy=Number(pb.yTop)-Number(pb.yBottom);if(!finite(dx)||!finite(dy)||!dx||!dy)return{source:'OPERA Europa CMAX',text:'brak geometrii',time:op.latest.time};
    const x=(xy[0]-Number(pb.x0))/dx*(w-1),y=(Number(pb.yTop)-xy[1])/dy*(h-1);if(x<0||y<0||x>w-1||y>h-1)return{source:'OPERA Europa CMAX',text:'poza analizowanym obszarem',time:op.latest.time};
    const v=median3(r.values,w,h,x,y);return{source:'OPERA Europa CMAX',text:finite(v)?`${Math.round(v)} dBZ`:'brak sygnału',time:op.latest.time,value:v};
  }

  async function identify(ll){
    const jobs=[];
    if(window.PrognozaEPIRPolradState)jobs.push(samplePolrad(ll));
    if($('operaCmaxToggle')?.classList.contains('active'))jobs.push(Promise.resolve(sampleOpera(ll)));
    if(!jobs.length)return;
    const s=await Promise.allSettled(jobs),rows=s.map(x=>x.status==='fulfilled'?x.value:{source:'Radar',text:'nie udało się odczytać wartości',time:null}).filter(Boolean);
    if(!rows.length)return;
    const html=rows.map(r=>`<div class="row"><b>${esc(r.text)}</b><br>${esc(r.source)}${r.time?' · '+esc(fmtUtc(r.time)):''}</div>`).join('');
    L.popup({closeButton:true,autoPan:true}).setLatLng(ll).setContent(`<div class="epir-point-popup">${html}<small>${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)}</small></div>`).openOn(map);
  }
  map.on('click',e=>identify(e.latlng).catch(err=>L.popup().setLatLng(e.latlng).setContent(`<div class="epir-point-popup"><b>Nie udało się odczytać punktu</b><br><small>${esc(err?.message||err)}</small></div>`).openOn(map)));

  // -------------------------------------------------------------------------
  // OPERA: a manual selection is independent. A mismatched POLRAD timestamp
  // must not make an active OPERA button display an empty map.
  function forceOpera(){
    const b=$('operaCmaxToggle'),engine=window.PrognozaEPIROperaNowcastEngine,op=window.PrognozaEPIROperaNowcast;
    if(!b?.classList.contains('active')||!engine?.syncToPolrad||!op?.latest||op.error)return;
    const t=Number(op.latest.time);if(!finite(t))return;
    try{engine.syncToPolrad({timeMs:t,frameEnd:t,comparableToOpera:true,short:'OPERA',product:'opera'});setTimeout(()=>{setStatus(`Mapa: OPERA Europa CMAX · ${fmtUtc(t)} · tryb niezależny.`);const x=$('opStatus');if(x)x.textContent=`OPERA ${fmtUtc(t)} · warstwa niezależna od synchronizacji POLRAD.`;},0);}catch(_){}
  }
  function bindOpera(){const b=$('operaCmaxToggle');if(!b||b.dataset.repairR6)return;b.dataset.repairR6='1';b.addEventListener('click',()=>setTimeout(forceOpera,0));}
  bindOpera();
  window.addEventListener('prognozaepir:opera-nowcast-updated',()=>setTimeout(()=>{bindOpera();forceOpera();},0));
  window.addEventListener('prognozaepir:polrad-frame-changed',()=>setTimeout(forceOpera,0));
  [300,900,1800,3500].forEach(ms=>setTimeout(()=>{bindOpera();forceOpera();},ms));

  // -------------------------------------------------------------------------
  // IMGW hazards: expired rows are never drawn, zero current warnings is a
  // valid working state, and a transient fetch failure never removes the button.
  const level=w=>clamp(Number(w?.stopien??w?.stopien_zagrozenia??w?.level??w?.Level??0)||0,0,3);
  const name=w=>w?.nazwa_zdarzenia||w?.zdarzenie||w?.event||w?.Event||w?.name||'Ostrzeżenie';
  function teryt(w){const raw=w?.teryt??w?.TERYT??w?.teryt_codes;if(Array.isArray(raw))return raw.map(String);if(typeof raw==='string')return raw.split(/[;,\s]+/).filter(Boolean);return[];}
  function time(v){if(v==null||v==='')return NaN;if(typeof v==='number')return v<1e12?v*1000:v;let x=Date.parse(String(v).trim());if(finite(x))return x;return Date.parse(String(v).trim().replace(' ','T'));}
  function current(w){const now=Date.now(),a=time(w?.obowiazuje_od??w?.valid_from??w?.validFrom??w?.ValidFrom??w?.from),b=time(w?.obowiazuje_do??w?.valid_to??w?.validTo??w?.ValidTo??w?.to);if(finite(b)&&b<now-5*60000)return false;if(finite(a)&&a>now+24*3600000)return false;return true;}
  function enhanced(j){const wo=j?.warnings||j?.Warnings;if(!wo)return[];const ar=j?.teryt||j?.Teryt||j?.areas||{};return Object.entries(wo).map(([id,w])=>({...w,teryt:w?.teryt||ar?.[id]||[]}));}
  async function warnings(){let rows=null,last=null;for(const url of['https://danepubliczne.imgw.pl/api/data/warningsmeteo','https://meteo.imgw.pl/api/meteo/messages/v1/osmet/latest/osmet-teryt']){const c=new AbortController(),tm=setTimeout(()=>c.abort(),9000);try{const r=await fetch(url,{cache:'no-store',signal:c.signal});if(!r.ok)throw new Error('HTTP '+r.status);const j=await r.json(),a=Array.isArray(j)?j:enhanced(j);if(Array.isArray(a)){rows=a;break;}}catch(e){last=e;}finally{clearTimeout(tm);}}if(!rows)throw last||new Error('brak danych IMGW');return rows.filter(w=>teryt(w).length&&current(w));}
  async function geo(){if(hazardGeo)return hazardGeo;let last=null;for(const url of['https://raw.githubusercontent.com/waszkiewiczja/GeoJSON-Polska-Wojewodztwa-Powiaty-Gminy/main/powiaty.json','https://cdn.jsdelivr.net/gh/waszkiewiczja/GeoJSON-Polska-Wojewodztwa-Powiaty-Gminy@main/powiaty.json']){try{const r=await fetch(url,{cache:'force-cache'});if(!r.ok)throw new Error('HTTP '+r.status);hazardGeo=await r.json();if(hazardGeo)return hazardGeo;}catch(e){last=e;}}throw last||new Error('brak granic powiatów');}
  const color=l=>l>=3?'#c62828':l===2?'#ef6c00':'#f9a825';
  function indexWarnings(rows){const m=new Map();for(const w of rows)for(const raw of teryt(w)){const c=String(raw).padStart(4,'0').slice(0,4),a=m.get(c)||[];a.push(w);m.set(c,a);}return m;}
  function draw(g,rows){const idx=indexWarnings(rows);if(hazardLayer)try{map.removeLayer(hazardLayer);}catch(_){}hazardLayer=L.geoJSON(g,{style:f=>{const c=String(f?.properties?.JPT_KOD_JE||'').padStart(4,'0').slice(0,4),wr=idx.get(c)||[],lev=wr.reduce((m,w)=>Math.max(m,level(w)),0);return lev?{color:color(lev),weight:1.2,fillColor:color(lev),fillOpacity:lev===3?.40:lev===2?.32:.24}:{color:'transparent',weight:0,fillOpacity:0};},onEachFeature:(f,l)=>{const c=String(f?.properties?.JPT_KOD_JE||'').padStart(4,'0').slice(0,4),wr=idx.get(c)||[];if(!wr.length)return;const n=f?.properties?.JPT_NAZWA_||('powiat '+c);l.bindTooltip('<b>'+esc(n)+'</b><br>'+wr.slice(0,3).map(w=>esc(name(w))+' · st. '+level(w)).join('<br>'),{sticky:true});}}).addTo(map);}
  function legend(show){if(show&&!hazardLegend){hazardLegend=L.control({position:'topright'});hazardLegend.onAdd=()=>{const d=L.DomUtil.create('div','hazard-legend');d.innerHTML='<b>Zagrożenia IMGW</b><br><i style="background:#f9a825"></i>stopień 1<br><i style="background:#ef6c00"></i>stopień 2<br><i style="background:#c62828"></i>stopień 3';return d;};hazardLegend.addTo(map);}else if(!show&&hazardLegend){map.removeControl(hazardLegend);hazardLegend=null;}}
  async function refreshHazards(){hazardButton.disabled=true;hazardButton.textContent='Zagrożenia…';try{const rows=await warnings();if(!rows.length){if(hazardLayer&&map.hasLayer(hazardLayer))map.removeLayer(hazardLayer);legend(false);hazardButton.classList.add('active');hazardButton.textContent='Zagrożenia IMGW · 0';setStatus('IMGW: brak aktualnych ostrzeżeń. Warstwa działa, ale nie ma aktywnych poligonów.');return;}const g=await geo();draw(g,rows);legend(true);hazardButton.classList.add('active');hazardButton.textContent=`Zagrożenia IMGW · ${rows.length}`;setStatus(`IMGW: ${rows.length} aktualnych ostrzeżeń; warstwa załadowana.`);}catch(e){hazardButton.classList.remove('active');hazardButton.textContent='Zagrożenia IMGW';legend(false);setStatus(`Zagrożenia IMGW chwilowo niedostępne: ${e?.message||e}. Można ponowić próbę.`);}finally{hazardButton.disabled=false;}}
  function installHazards(){const old=$('hazardsToggle');if(!old)return;const b=old.cloneNode(true);old.replaceWith(b);hazardButton=b;b.disabled=false;b.classList.remove('active');b.textContent='Zagrożenia IMGW';b.addEventListener('click',()=>{if(b.classList.contains('active')){b.classList.remove('active');b.textContent='Zagrożenia IMGW';if(hazardLayer&&map.hasLayer(hazardLayer))map.removeLayer(hazardLayer);legend(false);}else refreshHazards();});}
  installHazards();

  // Rebind if another late module recreated the controls.
  const observer=new MutationObserver(()=>{bindOpera();if(!hazardButton?.isConnected&&$('hazardsToggle'))installHazards();});
  observer.observe(document.querySelector('.mapbar')||document.body,{childList:true,subtree:true});
})();
