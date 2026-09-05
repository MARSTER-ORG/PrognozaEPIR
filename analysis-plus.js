'use strict';
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;
  const $ = id => document.getElementById(id);
  const mapEl = $('map');
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const RADII = [10,25,50,75,100];

  const version = document.querySelector('.brand small');
  if (version) version.textContent = 'RADAR / SAT / AI v0.11.9';

  const style = document.createElement('style');
  style.textContent = `
    .radius-profile-title{margin-top:10px;font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;font-weight:700}
    .radius-profile{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:5px;margin-top:6px}
    .radius-tile{border:1px solid var(--line);background:var(--panel2);border-radius:7px;padding:6px;cursor:pointer;touch-action:manipulation;min-height:62px}
    .radius-tile.active{border-color:var(--blue2);box-shadow:inset 0 0 0 1px var(--blue2)}
    .radius-tile b{display:block;font-size:11px;margin-bottom:3px}.radius-tile span{display:block;font-size:8px;color:var(--muted);line-height:1.3}
    .storm-hobby{padding:9px 10px}.storm-main{font-size:15px;font-weight:800;line-height:1.15}.storm-details{margin-top:5px;font-size:9px;color:var(--muted);line-height:1.4}
    .storm-radii{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:5px;margin-top:8px}.storm-radii div{background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:5px;text-align:center}.storm-radii b{display:block;font-size:10px}.storm-radii span{font-size:8px;color:var(--muted)}
    .storm-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.storm-actions button{border:1px solid var(--line);background:var(--panel2);color:var(--ink);border-radius:7px;padding:6px 8px;font-size:9px;font-weight:700}.storm-actions button.primary{background:var(--blue2);border-color:var(--blue2);color:#fff}
    @media(max-width:650px){.radius-profile,.storm-radii{grid-template-columns:repeat(5,minmax(58px,1fr));overflow-x:auto}.radius-tile{min-width:66px}}
  `;
  document.head.appendChild(style);

  function activeProduct(){ for (const p of ['cmax','sri','pac']) if ($('polrad_'+p)?.classList.contains('active')) return p; return null; }
  const PROFILE = {
    cmax:{unit:'dBZ',def:40}, sri:{unit:'mm/h',def:1}, pac:{unit:'mm',def:1}
  };
  function fmt(v,p){
    if (!Number.isFinite(v)) return '—';
    if (p === 'cmax') return '~'+Math.round(v)+' dBZ';
    const n = v < 1 ? v.toFixed(1) : Math.abs(v-Math.round(v)) < .05 ? String(Math.round(v)) : v.toFixed(1);
    return n.replace('.',',')+' '+PROFILE[p].unit;
  }
  function hsv(r,g,b){r/=255;g/=255;b/=255;const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;let h=0;if(d){if(mx===r)h=60*(((g-b)/d)%6);else if(mx===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4);}if(h<0)h+=360;return{h,s:mx?d/mx:0,v:mx};}
  function cmaxValue(r,g,b,a){
    if(a<80)return null;const {h,s,v}=hsv(r,g,b);if(s<.34||v<.16)return null;
    if(h>=225&&h<285){if(v<.30)return 5;if(v<.42)return 8;if(v<.54)return 11;if(v<.66)return 14;if(v<.80)return 17;return 20;}
    if(h>=195&&h<225)return v<.62?20:v<.82?23:26;
    if(h>=165&&h<195)return v<.72?26:29;
    if(h>=105&&h<165)return v<.66?29:v<.84?32:35;
    if(h>=70&&h<105)return v<.76?35:38;
    if(h>=48&&h<70)return 38;if(h>=35&&h<48)return 41;if(h>=20&&h<35)return 44;
    if(h<20||h>=350)return 47;if(h>=285&&h<350)return 50;return null;
  }
  function hydroValue(r,g,b,a){
    if(a<80)return null;const {h,s,v}=hsv(r,g,b);if(v<.16||s<.20)return null;
    if(h>=225&&h<285)return v<.45?.1:v<.65?.2:.3;if(h>=190&&h<225)return .6;if(h>=100&&h<190)return 1;
    if(h>=65&&h<100)return 1.7;if(h>=50&&h<65)return 3.1;if(h>=36&&h<50)return 5.4;if(h>=18&&h<36)return 9.6;
    if(h<18||h>=350)return 17;if(h>=285&&h<350)return 30;return null;
  }
  function pixelValue(p,r,g,b,a){ return p==='cmax' ? cmaxValue(r,g,b,a) : hydroValue(r,g,b,a); }

  function visibleImage(p){
    const imgs=[...map.getContainer().querySelectorAll('.leaflet-overlay-pane img.leaflet-image-layer')];
    return imgs.find(img=>{if(!img.complete||img.naturalWidth<2||getComputedStyle(img).display==='none')return false;const src=(img.currentSrc||img.src||'').toLowerCase();return src.includes('/'+p+'/')||src.includes('_'+p+'.')||src.includes('/'+p+'.');})||null;
  }
  function geometry(img){const ir=img.getBoundingClientRect(),mr=map.getContainer().getBoundingClientRect();if(ir.width<2||ir.height<2)throw new Error('brak geometrii warstwy');return{ir,mr};}
  let rasterCache=null;
  async function getRaster(){
    const p=activeProduct();if(!p)throw new Error('Włącz CMAX, SRI albo PAC 1 h.');
    let img=null;for(let i=0;i<20;i++){img=visibleImage(p);if(img)break;await sleep(70);}if(!img)throw new Error('Nie znaleziono obrazu '+p.toUpperCase()+'.');
    const key=p+'|'+(img.currentSrc||img.src)+'|'+img.naturalWidth+'x'+img.naturalHeight;
    if(rasterCache?.key===key){rasterCache.geo=geometry(img);return rasterCache;}
    const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0);
    let rgba;try{rgba=ctx.getImageData(0,0,c.width,c.height).data;}catch(_){throw new Error('CORS obrazu POLRAD');}
    return rasterCache={key,product:p,width:c.width,height:c.height,rgba,geo:geometry(img)};
  }
  function naturalFor(r,ll){const cp=map.latLngToContainerPoint([ll.lat,ll.lon??ll.lng]),cx=r.geo.mr.left+cp.x,cy=r.geo.mr.top+cp.y;return{x:(cx-r.geo.ir.left)/r.geo.ir.width*r.width,y:(cy-r.geo.ir.top)/r.geo.ir.height*r.height};}
  function llFor(r,x,y){const cx=r.geo.ir.left+((x+.5)/r.width)*r.geo.ir.width,cy=r.geo.ir.top+((y+.5)/r.height)*r.geo.ir.height,cp=L.point(cx-r.geo.mr.left,cy-r.geo.mr.top),ll=map.containerPointToLatLng(cp);return{lat:ll.lat,lon:ll.lng};}
  function atPixel(r,x,y){x=Math.round(x);y=Math.round(y);if(x<0||y<0||x>=r.width||y>=r.height)return null;const i=(y*r.width+x)*4;return pixelValue(r.product,r.rgba[i],r.rgba[i+1],r.rgba[i+2],r.rgba[i+3]);}
  function hav(a,b){const R=6371.0088,p1=toRad(a.lat),p2=toRad(b.lat),dp=toRad(b.lat-a.lat),dl=toRad(b.lon-a.lon),h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));}
  function dest(c,b,d){const R=6371.0088,br=toRad(b),p1=toRad(c.lat),l1=toRad(c.lon),dr=d/R,p2=Math.asin(Math.sin(p1)*Math.cos(dr)+Math.cos(p1)*Math.sin(dr)*Math.cos(br)),l2=l1+Math.atan2(Math.sin(br)*Math.sin(dr)*Math.cos(p1),Math.cos(dr)-Math.sin(p1)*Math.sin(p2));return{lat:toDeg(p2),lon:((toDeg(l2)+540)%360)-180};}

  // Fifth permanent range ring: existing code already creates 10/25/50/100 km.
  let ring75=null;
  function ensure75Ring(){
    if(typeof point==='undefined'||!Number.isFinite(Number(point.lat))||!Number.isFinite(Number(point.lon)))return;
    if(!ring75){ring75=L.circle([Number(point.lat),Number(point.lon)],{radius:75000,color:'#1f2a75',weight:1,fill:false,dashArray:'4 4'}).addTo(map);}else ring75.setLatLng([Number(point.lat),Number(point.lon)]);
  }
  ensure75Ring();
  if(typeof updatePointUI==='function'&&!window.__radius75Patched){window.__radius75Patched=true;const prev=updatePointUI;updatePointUI=function(){const out=prev.apply(this,arguments);ensure75Ring();return out;};}
  for(const id of ['apply','resetPoint']) $(id)?.addEventListener('click',()=>setTimeout(ensure75Ring,250));

  function normalizeRadiusSelect(){
    const sel=$('echoRadius');if(!sel)return;const old=Number(sel.value);sel.innerHTML=RADII.map(r=>'<option value="'+r+'">'+r+' km</option>').join('');sel.value=RADII.includes(old)?String(old):'100';
  }

  let profileWrap=null;
  function ensureProfileUi(){
    normalizeRadiusSelect();const info=$('echoInfo');if(!info||$('radiusProfile'))return;
    const title=document.createElement('div');title.className='radius-profile-title';title.textContent='Profil 10 / 25 / 50 / 75 / 100 km';
    profileWrap=document.createElement('div');profileWrap.id='radiusProfile';profileWrap.className='radius-profile';
    profileWrap.innerHTML=RADII.map(r=>'<div class="radius-tile" data-radius="'+r+'" role="button" tabindex="0"><b>'+r+' km</b><span>uruchom analizę…</span></div>').join('');
    info.insertAdjacentElement('afterend',title);title.insertAdjacentElement('afterend',profileWrap);
    profileWrap.addEventListener('click',e=>{const t=e.target.closest('.radius-tile');if(!t)return;const r=Number(t.dataset.radius);const sel=$('echoRadius');if(sel)sel.value=String(r);$('echoAnalyze')?.click();});
    profileWrap.addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;const t=e.target.closest('.radius-tile');if(!t)return;e.preventDefault();const sel=$('echoRadius');if(sel)sel.value=t.dataset.radius;$('echoAnalyze')?.click();});
  }

  const rightColumn=document.querySelector('.layout > div:nth-child(2)');
  let stormCard=null;
  function ensureStormUi(){
    if($('stormHobbyCard')||!rightColumn)return;
    stormCard=document.createElement('section');stormCard.id='stormHobbyCard';stormCard.className='card';stormCard.style.marginTop='8px';
    stormCard.innerHTML='<h2>Aktywność burzowa · ocena hobbystyczna</h2><div class="storm-hobby"><div id="stormMain" class="storm-main">—</div><div id="stormDetails" class="storm-details">Analiza korzysta z EUMETSAT MTG Lightning Imager oraz aktualnie aktywnej warstwy POLRAD. Nie jest to ostrzeżenie IMGW.</div><div id="stormRadii" class="storm-radii">'+RADII.map(r=>'<div><b>'+r+' km</b><span>—</span></div>').join('')+'</div><div class="storm-actions"><button id="stormRefresh" class="primary" type="button">Odśwież ocenę</button><button id="stormBlitz" type="button">⚡ Sprawdź Blitzortung LIVE</button></div></div>';
    const analysis=$('echoDistanceCard');analysis?.insertAdjacentElement('afterend',stormCard);
    $('stormRefresh')?.addEventListener('click',()=>refreshStorm(true));
    $('stormBlitz')?.addEventListener('click',()=>window.PrognozaEPIRMapExtras?.showBlitzortung?.());
  }

  let lastProfiles=null;
  async function scanProfiles(){
    ensureProfileUi();const p=activeProduct();if(!p||typeof point==='undefined'||!profileWrap)return null;
    const threshold=Number($('echoThreshold')?.value)||PROFILE[p].def,center={lat:Number(point.lat),lon:Number(point.lon)};
    const r=await getRaster(),pc=naturalFor(r,center),pe=naturalFor(r,dest(center,90,100)),pn=naturalFor(r,dest(center,0,100)),rx=Math.abs(pe.x-pc.x),ry=Math.abs(pn.y-pc.y);
    if(rx<2||ry<2)throw new Error('za mała rozdzielczość');
    const x0=Math.max(0,Math.floor(pc.x-rx)),x1=Math.min(r.width-1,Math.ceil(pc.x+rx)),y0=Math.max(0,Math.floor(pc.y-ry)),y1=Math.min(r.height-1,Math.ceil(pc.y+ry)),stride=Math.max(1,Math.floor(Math.max(rx,ry)/230));
    const stats=Object.fromEntries(RADII.map(R=>[R,{radius:R,total:0,valid:0,above:0,max:null,nearest:null}]));let row=0;
    for(let y=y0;y<=y1;y+=stride){const ny=(y-pc.y)/ry;for(let x=x0;x<=x1;x+=stride){const nx=(x-pc.x)/rx;if(nx*nx+ny*ny>1)continue;const ll=llFor(r,x,y),dist=hav(center,ll);if(dist>101)continue;const v=atPixel(r,x,y);for(const R of RADII){if(dist>R*1.015)continue;const s=stats[R];s.total++;if(Number.isFinite(v)){s.valid++;if(!s.max||v>s.max.v)s.max={v,ll,dist};if(v>=threshold){s.above++;if(!s.nearest||dist<s.nearest.dist)s.nearest={v,ll,dist};}}}}if((++row%16)===0)await sleep(0);}
    lastProfiles={product:p,threshold,stats,at:Date.now()};
    for(const R of RADII){const s=stats[R],tile=profileWrap.querySelector('[data-radius="'+R+'"]'),coverage=s.total?100*s.above/s.total:0;const max=s.max?fmt(s.max.v,p):'brak';const near=s.nearest?(s.nearest.dist<10?s.nearest.dist.toFixed(1):s.nearest.dist.toFixed(0))+' km':'brak';if(tile)tile.querySelector('span').innerHTML='max '+max+'<br>≥ próg '+coverage.toFixed(1).replace('.',',')+'%<br>najbliżej '+near;}
    const selected=Number($('echoRadius')?.value)||100;profileWrap.querySelectorAll('.radius-tile').forEach(t=>t.classList.toggle('active',Number(t.dataset.radius)===selected));
    window.PrognozaEPIRRadiusProfile=lastProfiles;return lastProfiles;
  }

  // MTG LI AFA analysis for hobby storm activity — independent of Blitzortung data.
  const WMS='https://view.eumetsat.int/geoserver/wms';
  let liCache=null;
  function bboxFor(center,radius=100){const n=dest(center,0,radius),e=dest(center,90,radius),s=dest(center,180,radius),w=dest(center,270,radius),sw=L.CRS.EPSG3857.project(L.latLng(s.lat,w.lon)),ne=L.CRS.EPSG3857.project(L.latLng(n.lat,e.lon));return{minX:sw.x,minY:sw.y,maxX:ne.x,maxY:ne.y};}
  function liUrl(box,w=512,h=512){const q=new URLSearchParams({service:'WMS',request:'GetMap',version:'1.1.1',layers:'mtg_fd:li_afa',styles:'',format:'image/png',transparent:'true',srs:'EPSG:3857',bbox:[box.minX,box.minY,box.maxX,box.maxY].join(','),width:String(w),height:String(h)});q.set('_ts',String(Math.floor(Date.now()/60000)));return WMS+'?'+q;}
  function loadImage(url){return new Promise((resolve,reject)=>{const img=new Image();img.crossOrigin='anonymous';img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('błąd pobierania MTG LI'));img.src=url;});}
  function liSignal(r,g,b,a){if(a<20)return false;const mx=Math.max(r,g,b),mn=Math.min(r,g,b);return mx>45&&(mx-mn)>18;}
  async function lightningPoints(center){
    const cacheKey=center.lat.toFixed(2)+','+center.lon.toFixed(2)+'|'+Math.floor(Date.now()/55000);if(liCache?.key===cacheKey)return liCache.points;
    const box=bboxFor(center,100),img=await loadImage(liUrl(box)),W=512,H=512,c=document.createElement('canvas');c.width=W;c.height=H;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0,W,H);
    let data;try{data=ctx.getImageData(0,0,W,H).data;}catch(_){throw new Error('CORS MTG LI');}
    const block=4,gw=Math.ceil(W/block),gh=Math.ceil(H/block),occ=new Uint8Array(gw*gh);for(let gy=0;gy<gh;gy++)for(let gx=0;gx<gw;gx++){let hit=false;for(let yy=0;yy<block&&!hit;yy++)for(let xx=0;xx<block;xx++){const x=gx*block+xx,y=gy*block+yy;if(x>=W||y>=H)continue;const i=(y*W+x)*4;if(liSignal(data[i],data[i+1],data[i+2],data[i+3])){hit=true;break;}}if(hit)occ[gy*gw+gx]=1;}
    const seen=new Uint8Array(gw*gh),out=[];for(let gy=0;gy<gh;gy++)for(let gx=0;gx<gw;gx++){const k0=gy*gw+gx;if(!occ[k0]||seen[k0])continue;const stack=[[gx,gy]];seen[k0]=1;let sx=0,sy=0,n=0;while(stack.length){const [x,y]=stack.pop();sx+=x;sy+=y;n++;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=gw||ny>=gh)continue;const k=ny*gw+nx;if(occ[k]&&!seen[k]){seen[k]=1;stack.push([nx,ny]);}}}const px=(sx/n+.5)*block,py=(sy/n+.5)*block,fx=px/W,fy=py/H,x=box.minX+fx*(box.maxX-box.minX),y=box.maxY-fy*(box.maxY-box.minY),ll=L.CRS.EPSG3857.unproject(L.point(x,y));const dist=hav(center,{lat:ll.lat,lon:ll.lng});if(dist<=105)out.push({lat:ll.lat,lon:ll.lng,dist,size:n});}
    liCache={key:cacheKey,points:out};return out;
  }

  let stormBusy=false;
  async function refreshStorm(force=false){
    ensureStormUi();if(stormBusy||typeof point==='undefined')return;stormBusy=true;const main=$('stormMain'),details=$('stormDetails');if(main)main.textContent='Analizuję MTG LI…';
    try{
      const center={lat:Number(point.lat),lon:Number(point.lon)},pts=await lightningPoints(center);pts.sort((a,b)=>a.dist-b.dist);const nearest=pts[0]||null,counts=RADII.map(R=>pts.filter(p=>p.dist<=R).length);
      let level='Brak wykrytej aktywności LI ≤100 km';
      if(nearest){if(nearest.dist<=10)level='Aktywność elektryczna bardzo blisko';else if(nearest.dist<=25)level='Aktywność elektryczna blisko';else if(nearest.dist<=50)level='Aktywność burzowa w pobliżu';else if(nearest.dist<=75)level='Aktywność burzowa w regionie';else level='Odległa aktywność burzowa';}
      let radarText='';const p=activeProduct();const prof=lastProfiles&&lastProfiles.product===p?lastProfiles:null;const max100=prof?.stats?.[100]?.max?.v;
      if(Number.isFinite(max100)){radarText=' Aktywna warstwa '+p.toUpperCase()+': maksimum '+fmt(max100,p)+' w 100 km.';if(p==='cmax'&&max100>=45&&nearest&&nearest.dist<=50)level+=' + silne echo radarowe';if(p==='sri'&&max100>=5.4&&nearest&&nearest.dist<=50)level+=' + intensywny opad';}
      if(main)main.textContent=level;
      if(details)details.textContent=(nearest?'Najbliższy obszar MTG LI: '+(nearest.dist<10?nearest.dist.toFixed(1):nearest.dist.toFixed(0))+' km.':'W bieżącej 5-minutowej akumulacji nie rozpoznano obszaru LI w 100 km.')+radarText+' Ocena hobbystyczna — nie jest ostrzeżeniem IMGW.';
      const cells=$('stormRadii')?.children;counts.forEach((n,i)=>{if(cells?.[i])cells[i].querySelector('span').textContent=n+' obsz. LI';});
    }catch(e){if(main)main.textContent='Brak danych MTG LI';if(details)details.textContent='Nie udało się wykonać hobbystycznej oceny aktywności: '+(e?.message||e)+'. Blitzortung LIVE pozostaje dostępny do ręcznego podglądu.';}
    finally{stormBusy=false;}
  }

  function hookAnalysis(){
    ensureProfileUi();ensureStormUi();const btn=$('echoAnalyze');if(btn&&!btn.dataset.plus119){btn.dataset.plus119='1';btn.addEventListener('click',()=>setTimeout(async()=>{try{await scanProfiles();}catch(_){}refreshStorm(true);},180));}
    const presets=$('echoPresets');if(presets&&!presets.dataset.plus119){presets.dataset.plus119='1';presets.addEventListener('click',()=>setTimeout(async()=>{try{await scanProfiles();}catch(_){}refreshStorm(true);},220));}
  }
  hookAnalysis();setTimeout(hookAnalysis,900);setInterval(hookAnalysis,1500);
  for(const p of ['cmax','sri','pac']) $('polrad_'+p)?.addEventListener('click',()=>{rasterCache=null;setTimeout(()=>{normalizeRadiusSelect();refreshStorm(true);},500);});
  $('radarFrame')?.addEventListener('input',()=>{rasterCache=null;setTimeout(refreshStorm,350);});
  for(const id of ['apply','resetPoint']) $(id)?.addEventListener('click',()=>{rasterCache=null;liCache=null;setTimeout(()=>{ensure75Ring();refreshStorm(true);},500);});
  setTimeout(()=>{ensureProfileUi();ensureStormUi();refreshStorm(true);},1400);
  setInterval(()=>refreshStorm(false),60000);
})();
