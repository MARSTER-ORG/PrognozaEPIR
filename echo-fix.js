'use strict';
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;
  const $ = id => document.getElementById(id);
  const clamp = (v,a,b) => Math.max(a, Math.min(b,v));
  const toRad = d => d*Math.PI/180;
  const toDeg = r => r*180/Math.PI;
  const sleep = ms => new Promise(r=>setTimeout(r,ms));

  const version=document.querySelector('.brand small');
  if(version) version.textContent='RADAR / SAT / AI v0.11.7';

  const PROFILE={
    cmax:{unit:'dBZ',name:'odbiciowość',def:40,min:5,max:55,step:1,note:'POLRAD CMAX'},
    sri:{unit:'mm/h',name:'natężenie opadu',def:1,min:.1,max:30,step:.1,note:'POLRAD SRI'},
    pac:{unit:'mm',name:'suma opadu 1 h',def:1,min:.1,max:30,step:.1,note:'POLRAD PAC 1 h'}
  };

  let rasterCache=null;
  let fixedLine=null,fixedMarker=null;
  let press=null,suppressClickUntil=0;

  function activeProduct(){for(const p of ['cmax','sri','pac']) if($('polrad_'+p)?.classList.contains('active')) return p;return null;}
  function fmt(v,p){if(!Number.isFinite(Number(v)))return'—';const n=Number(v);if(p==='cmax')return Math.round(n)+' dBZ';return (n<1?n.toFixed(1):Math.abs(n-Math.round(n))<.05?Math.round(n):n.toFixed(1)).toString().replace('.',',')+' '+PROFILE[p].unit;}
  function hsv(r,g,b){r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;let h=0;if(d){if(mx===r)h=60*(((g-b)/d)%6);else if(mx===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4);}if(h<0)h+=360;return{h,s:mx?d/mx:0,v:mx};}

  // CMAX: 16 stopni stosowanych w legendzie POLRAD/Rainbow: 5,8,...47, >50 dBZ.
  // Dekoder wykorzystuje barwę i jasność piksela, a wynik oznaczamy jako orientacyjny (~),
  // ponieważ analizujemy render PNG, a nie surową siatkę HDF5.
  function cmaxValue(r,g,b,a){
    if(a<80)return null;
    const {h,s,v}=hsv(r,g,b);
    if(s<.34||v<.16)return null;
    let z=null;
    if(h>=225&&h<285){
      if(v<.30)z=5; else if(v<.42)z=8; else if(v<.54)z=11; else if(v<.66)z=14; else if(v<.80)z=17; else z=20;
    } else if(h>=195&&h<225){ z=v<.62?20:v<.82?23:26; }
    else if(h>=165&&h<195){ z=v<.72?26:29; }
    else if(h>=105&&h<165){ z=v<.66?29:v<.84?32:35; }
    else if(h>=70&&h<105){ z=v<.76?35:38; }
    else if(h>=48&&h<70){ z=38; }
    else if(h>=35&&h<48){ z=41; }
    else if(h>=20&&h<35){ z=44; }
    else if(h<20||h>=350){ z=47; }
    else if(h>=285&&h<350){ z=50; }
    return z;
  }

  function hydroValue(r,g,b,a){
    if(a<80)return null;
    const {h,s,v}=hsv(r,g,b);if(v<.16||s<.20)return null;
    if(h>=225&&h<285)return v<.45?.1:v<.65?.2:.3;
    if(h>=190&&h<225)return .6;
    if(h>=100&&h<190)return 1;
    if(h>=65&&h<100)return 1.7;
    if(h>=50&&h<65)return 3.1;
    if(h>=36&&h<50)return 5.4;
    if(h>=18&&h<36)return 9.6;
    if(h<18||h>=350)return 17;
    if(h>=285&&h<350)return 30;
    return null;
  }
  function pixelValue(p,r,g,b,a){return p==='cmax'?cmaxValue(r,g,b,a):hydroValue(r,g,b,a);}

  function visibleImage(p){
    const imgs=[...map.getContainer().querySelectorAll('.leaflet-overlay-pane img.leaflet-image-layer')];
    return imgs.find(img=>{if(!img.complete||img.naturalWidth<2||getComputedStyle(img).display==='none')return false;const src=(img.currentSrc||img.src||'').toLowerCase();return src.includes('/'+p+'/')||src.includes('_'+p+'.')||src.includes('/'+p+'.');})||null;
  }
  function geometry(img){const ir=img.getBoundingClientRect(),mr=map.getContainer().getBoundingClientRect();if(ir.width<2||ir.height<2)throw new Error('brak geometrii aktywnej warstwy');return{ir,mr};}
  async function getRaster(){
    const p=activeProduct();if(!p)throw new Error('Włącz CMAX, SRI albo PAC 1 h.');
    let img=null;for(let i=0;i<20;i++){img=visibleImage(p);if(img)break;await sleep(80);}if(!img)throw new Error('Nie znaleziono obrazu '+p.toUpperCase()+'.');
    const key=p+'|'+(img.currentSrc||img.src)+'|'+img.naturalWidth+'x'+img.naturalHeight;
    if(rasterCache?.key===key){rasterCache.geo=geometry(img);return rasterCache;}
    const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0);
    let rgba;try{rgba=ctx.getImageData(0,0,c.width,c.height).data;}catch(_){throw new Error('Przeglądarka zablokowała odczyt obrazu POLRAD (CORS).');}
    const label=($('radarTime')?.textContent||'aktualna klatka').trim();
    return rasterCache={key,product:p,width:c.width,height:c.height,rgba,geo:geometry(img),label};
  }
  function naturalFor(r,ll){const cp=map.latLngToContainerPoint([ll.lat,ll.lon??ll.lng]),cx=r.geo.mr.left+cp.x,cy=r.geo.mr.top+cp.y;return{x:(cx-r.geo.ir.left)/r.geo.ir.width*r.width,y:(cy-r.geo.ir.top)/r.geo.ir.height*r.height};}
  function llFor(r,x,y){const cx=r.geo.ir.left+((x+.5)/r.width)*r.geo.ir.width,cy=r.geo.ir.top+((y+.5)/r.height)*r.geo.ir.height,cp=L.point(cx-r.geo.mr.left,cy-r.geo.mr.top),ll=map.containerPointToLatLng(cp);return{lat:ll.lat,lon:ll.lng};}
  function atPixel(r,x,y){x=Math.round(x);y=Math.round(y);if(x<0||y<0||x>=r.width||y>=r.height)return null;const i=(y*r.width+x)*4;return pixelValue(r.product,r.rgba[i],r.rgba[i+1],r.rgba[i+2],r.rgba[i+3]);}
  function localValue(r,ll){
    const p=naturalFor(r,ll),vals=[];
    for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const v=atPixel(r,p.x+dx,p.y+dy);if(Number.isFinite(v))vals.push(v);}
    if(!vals.length)return null;vals.sort((a,b)=>a-b);return vals[Math.floor(vals.length/2)];
  }
  function hav(a,b){const R=6371.0088,p1=toRad(a.lat),p2=toRad(b.lat),dp=toRad(b.lat-a.lat),dl=toRad(b.lon-a.lon),h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));}
  function bearing(a,b){const p1=toRad(a.lat),p2=toRad(b.lat),dl=toRad(b.lon-a.lon),y=Math.sin(dl)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);return(toDeg(Math.atan2(y,x))+360)%360;}
  function compass(d){const a=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];return a[Math.round(d/22.5)%16];}
  function dest(c,b,d){const R=6371.0088,br=toRad(b),p1=toRad(c.lat),l1=toRad(c.lon),dr=d/R,p2=Math.asin(Math.sin(p1)*Math.cos(dr)+Math.cos(p1)*Math.sin(dr)*Math.cos(br)),l2=l1+Math.atan2(Math.sin(br)*Math.sin(dr)*Math.cos(p1),Math.cos(dr)-Math.sin(p1)*Math.sin(p2));return{lat:toDeg(p2),lon:((toDeg(l2)+540)%360)-180};}
  function clearFixed(){for(const l of[fixedLine,fixedMarker])if(l&&map.hasLayer(l))map.removeLayer(l);fixedLine=fixedMarker=null;}

  async function updatePoint(){
    const p=activeProduct();if(!p||typeof point==='undefined')return;
    try{const r=await getRaster(),v=localValue(r,{lat:Number(point.lat),lon:Number(point.lon)});const el=$('dbz'),note=$('dbzNote');if(el)el.textContent=v==null?'brak sygnału':(p==='cmax'?'~'+fmt(v,p):fmt(v,p));if(note)note.textContent=PROFILE[p].note+' · '+r.label;}catch(_){ }
  }

  async function showValue(ll){
    const p=activeProduct();if(!p){L.popup().setLatLng(ll).setContent('Włącz CMAX, SRI albo PAC 1 h.').openOn(map);return;}
    try{const r=await getRaster(),v=localValue(r,{lat:ll.lat,lon:ll.lng});const text=v==null?'brak sygnału':(p==='cmax'?'~'+fmt(v,p):fmt(v,p));L.popup({closeButton:true,autoPan:true}).setLatLng(ll).setContent('<div class="radar-click-popup"><b>'+text+'</b><br>'+PROFILE[p].note+' · '+r.label+'<br><small>'+ll.lat.toFixed(4)+', '+ll.lng.toFixed(4)+'</small></div>').openOn(map);}catch(e){L.popup().setLatLng(ll).setContent('Nie udało się odczytać warstwy.<br><small>'+(e?.message||e)+'</small>').openOn(map);}
  }

  async function analyzeFixed(){
    const p=activeProduct(),pr=p?PROFILE[p]:null,info=$('echoInfo');if(!pr)return;
    const inp=$('echoThreshold'),raw=Number(inp?.value),threshold=clamp(Number.isFinite(raw)?raw:pr.def,pr.min,pr.max),radius=clamp(Number($('echoRadius')?.value)||100,5,100);
    if(inp)inp.value=threshold;
    if($('echoSettings'))$('echoSettings').textContent=fmt(threshold,p);
    if($('echoSettingsRadius'))$('echoSettingsRadius').textContent=radius+' km';
    for(const id of['echoDistance','echoBearing','echoFoundValue','echoCoords','echoMaxValue'])if($(id))$(id).textContent='—';
    if($('echoCompass'))$('echoCompass').textContent='—';if($('echoFrameTime'))$('echoFrameTime').textContent='—';if($('echoMaxCoords'))$('echoMaxCoords').textContent='—';
    info?.classList.remove('error');if(info)info.textContent='Analizuję '+p.toUpperCase()+' w promieniu '+radius+' km…';
    try{
      if(typeof point==='undefined')throw new Error('Brak punktu odniesienia.');
      const center={lat:Number(point.lat),lon:Number(point.lon)};
      const r=await getRaster();
      const pc=naturalFor(r,center),pe=naturalFor(r,dest(center,90,radius)),pn=naturalFor(r,dest(center,0,radius)),rx=Math.abs(pe.x-pc.x),ry=Math.abs(pn.y-pc.y);
      const x0=Math.max(0,Math.floor(pc.x-rx)),x1=Math.min(r.width-1,Math.ceil(pc.x+rx)),y0=Math.max(0,Math.floor(pc.y-ry)),y1=Math.min(r.height-1,Math.ceil(pc.y+ry)),stride=Math.max(1,Math.floor(Math.max(rx,ry)/260));
      const qualified=[],qset=new Set();let maximum=null,row=0;
      for(let y=y0;y<=y1;y+=stride){const ny=(y-pc.y)/ry;for(let x=x0;x<=x1;x+=stride){const nx=(x-pc.x)/rx;if(nx*nx+ny*ny>1)continue;const v=atPixel(r,x,y);if(!Number.isFinite(v))continue;const ll=llFor(r,x,y),dist=hav(center,ll);if(dist>radius*1.02)continue;const item={x,y,gx:Math.round((x-x0)/stride),gy:Math.round((y-y0)/stride),v,ll,dist};if(!maximum||v>maximum.v)maximum=item;if(v>=threshold){qualified.push(item);qset.add(item.gx+','+item.gy);}}if((++row%16)===0)await sleep(0);}
      let nearest=null;for(const it of qualified){let n=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;if(qset.has((it.gx+dx)+','+(it.gy+dy)))n++;}if(n<2)continue;if(!nearest||it.dist<nearest.dist)nearest=it;}
      if($('echoFrameTime'))$('echoFrameTime').textContent=r.label;
      if(maximum){if($('echoMaxValue'))$('echoMaxValue').textContent=(p==='cmax'?'~':'')+fmt(maximum.v,p);if($('echoMaxCoords'))$('echoMaxCoords').textContent=maximum.ll.lat.toFixed(4)+', '+maximum.ll.lon.toFixed(4);}
      clearFixed();
      if(!nearest){if($('echoDistance'))$('echoDistance').textContent='brak';if(info)info.textContent='Brak spójnego obszaru ≥ '+fmt(threshold,p)+' w promieniu '+radius+' km.';return;}
      const b=bearing(center,nearest.ll);if($('echoDistance'))$('echoDistance').textContent=(nearest.dist<10?nearest.dist.toFixed(1):nearest.dist.toFixed(0))+' km';if($('echoBearing'))$('echoBearing').textContent=Math.round(b)+'°';if($('echoCompass'))$('echoCompass').textContent=compass(b)+' · azymut od punktu';if($('echoFoundValue'))$('echoFoundValue').textContent=(p==='cmax'?'~':'')+fmt(nearest.v,p);if($('echoCoords'))$('echoCoords').textContent=nearest.ll.lat.toFixed(4)+', '+nearest.ll.lon.toFixed(4);
      fixedLine=L.polyline([[center.lat,center.lon],[nearest.ll.lat,nearest.ll.lon]],{pane:'analysisResultPane',color:'#ff5b52',weight:2,dashArray:'7 5',interactive:false}).addTo(map);fixedMarker=L.circleMarker([nearest.ll.lat,nearest.ll.lon],{pane:'analysisResultPane',radius:6,color:'#ff5b52',weight:2,fillColor:'#fff',fillOpacity:1,interactive:false}).addTo(map);if(info)info.textContent='Najbliższy spójny obszar ≥ '+fmt(threshold,p)+'. CMAX jest odczytem orientacyjnym z palety obrazu.';
    }catch(e){info?.classList.add('error');if(info)info.textContent='Analiza nie powiodła się: '+(e?.message||e);}
  }

  function takeoverControls(){
    const old=$('echoAnalyze');if(old&&!old.dataset.fixed117){const n=old.cloneNode(true);n.dataset.fixed117='1';old.replaceWith(n);n.addEventListener('click',analyzeFixed);}
    const presets=$('echoPresets');if(presets&&!presets.dataset.fixed117){presets.dataset.fixed117='1';presets.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;e.preventDefault();e.stopImmediatePropagation();const v=Number(b.dataset.v);if(Number.isFinite(v)&&$('echoThreshold'))$('echoThreshold').value=v;analyzeFixed();},true);}
    const inp=$('echoThreshold');if(inp&&!inp.dataset.fixed117){inp.dataset.fixed117='1';inp.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();e.stopImmediatePropagation();analyzeFixed();}},true);}
  }

  const mapEl=$('map');
  if(mapEl){
    mapEl.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'&&e.button!==0)return;press={id:e.pointerId,x:e.clientX,y:e.clientY,t:performance.now(),moved:false};},{capture:true,passive:true});
    mapEl.addEventListener('pointermove',e=>{if(!press||press.id!==e.pointerId)return;if(Math.hypot(e.clientX-press.x,e.clientY-press.y)>28)press.moved=true;},{capture:true,passive:true});
    mapEl.addEventListener('pointerup',e=>{if(!press||press.id!==e.pointerId)return;const s=press;press=null;const dt=performance.now()-s.t;if(s.moved||dt>1200){suppressClickUntil=performance.now()+700;return;}suppressClickUntil=performance.now()+450;const rect=mapEl.getBoundingClientRect(),ll=map.containerPointToLatLng(L.point(s.x-rect.left,s.y-rect.top));setTimeout(()=>showValue(ll),20);},{capture:true,passive:true});
    mapEl.addEventListener('click',e=>{if(performance.now()<suppressClickUntil)return;const rect=mapEl.getBoundingClientRect(),ll=map.containerPointToLatLng(L.point(e.clientX-rect.left,e.clientY-rect.top));showValue(ll);},{capture:false,passive:true});
  }

  const contextChanged=()=>{rasterCache=null;clearFixed();setTimeout(()=>{takeoverControls();updatePoint();},500);};
  for(const p of['cmax','sri','pac'])$('polrad_'+p)?.addEventListener('click',contextChanged);
  $('radarFrame')?.addEventListener('input',contextChanged);
  $('apply')?.addEventListener('click',contextChanged);
  $('resetPoint')?.addEventListener('click',contextChanged);
  setTimeout(()=>{takeoverControls();updatePoint();},900);
  setInterval(takeoverControls,1200);
})();
