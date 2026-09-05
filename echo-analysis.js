'use strict';
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;

  const $ = id => document.getElementById(id);
  const toRad = d => d * Math.PI / 180;
  const toDeg = r => r * 180 / Math.PI;
  const clamp = (v,a,b) => Math.max(a, Math.min(b, v));
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  const version = document.querySelector('.brand small');
  if (version) version.textContent = 'RADAR / SAT / AI v0.11.6';

  const style = document.createElement('style');
  style.textContent = `
    .echo-tools{padding:9px 10px}
    .echo-controls{display:flex;flex-wrap:wrap;gap:7px;align-items:end}
    .echo-field{display:flex;flex-direction:column;gap:3px;min-width:105px}
    .echo-field label{font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
    .echo-field input,.echo-field select,.echo-controls button{border:1px solid var(--line);background:var(--panel2);color:var(--ink);border-radius:7px;padding:7px 9px;font-size:11px}
    .echo-controls button{background:var(--blue2);color:#fff;border-color:var(--blue2);font-weight:700}
    .echo-presets{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}
    .echo-presets button{border:1px solid var(--line);background:var(--panel2);color:var(--ink);border-radius:6px;padding:5px 7px;font-size:9px}
    .echo-results{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:9px}
    .echo-result{background:var(--panel2);border-left:3px solid var(--blue2);padding:7px;min-height:58px}
    .echo-result small{display:block;color:var(--muted);font-size:9px;margin-bottom:3px}
    .echo-result strong{display:block;font-size:15px;line-height:1.1}
    .echo-result span{display:block;color:var(--muted);font-size:8.5px;margin-top:3px;overflow-wrap:anywhere}
    .echo-info{margin-top:8px;font-size:9px;color:var(--muted);line-height:1.35}
    .echo-info.error{color:var(--red)}
    .radar-click-popup{font-size:11px;line-height:1.35;min-width:155px}
    .radar-click-popup b{font-size:14px;color:#1f2a75}
    @media(max-width:560px){.echo-results{grid-template-columns:repeat(2,minmax(0,1fr))}.echo-field{min-width:92px;flex:1}.echo-controls button{width:100%}}
  `;
  document.head.appendChild(style);

  const PROFILES = {
    cmax: {
      title:'Analiza POLRAD · CMAX', valueName:'Odbiciowość', thresholdLabel:'Próg odbiciowości', unit:'dBZ',
      min:27,max:60,step:1,def:40,
      presets:[[27,'Echo ≥27 dBZ'],[35,'Opad ≥35 dBZ'],[40,'Mocniejsze ≥40 dBZ'],[45,'Silne ≥45 dBZ'],[50,'Konwekcyjne ≥50 dBZ'],[55,'Bardzo silne ≥55 dBZ']],
      pointLabel:'Odbiciowość radarowa', trendLabel:'Trend CMAX', note:'POLRAD CMAX', kind:'cmax'
    },
    sri: {
      title:'Analiza POLRAD · SRI — natężenie opadu', valueName:'Natężenie opadu', thresholdLabel:'Próg natężenia opadu', unit:'mm/h',
      min:0.1,max:30,step:0.1,def:1.0,
      presets:[[0.1,'≥0,1 mm/h'],[0.6,'≥0,6 mm/h'],[1.7,'≥1,7 mm/h'],[5.4,'≥5,4 mm/h'],[17,'≥17 mm/h'],[30,'≥30 mm/h']],
      pointLabel:'Natężenie opadu radarowego', trendLabel:'Trend SRI', note:'POLRAD SRI', kind:'hydro'
    },
    pac: {
      title:'Analiza POLRAD · PAC 1 h — suma opadu', valueName:'Suma opadu 1 h', thresholdLabel:'Próg sumy opadu', unit:'mm',
      min:0.1,max:30,step:0.1,def:1.0,
      presets:[[0.1,'≥0,1 mm'],[0.6,'≥0,6 mm'],[1.7,'≥1,7 mm'],[5.4,'≥5,4 mm'],[17,'≥17 mm'],[30,'≥30 mm']],
      pointLabel:'Suma opadu radarowego 1 h', trendLabel:'Trend PAC 1 h', note:'POLRAD PAC 1 h', kind:'hydro'
    }
  };
  const lastThreshold = {cmax:40,sri:1.0,pac:1.0};

  const rightColumn = document.querySelector('.layout > div:nth-child(2)');
  if (!rightColumn) return;
  $('echoDistanceCard')?.remove();
  const dataCard = [...rightColumn.querySelectorAll('.card')].find(c => c.querySelector('h2')?.textContent.includes('Dane dla punktu'));

  const card = document.createElement('section');
  card.id = 'echoDistanceCard';
  card.className = 'card';
  card.style.marginTop = '8px';
  card.innerHTML = `
    <h2 id="echoHeading">Analiza POLRAD</h2>
    <div class="echo-tools">
      <div class="echo-controls">
        <div class="echo-field"><label id="echoThresholdLabel" for="echoThreshold">Próg</label><input id="echoThreshold" type="number" inputmode="decimal"></div>
        <div class="echo-field"><label for="echoRadius">Promień analizy</label><select id="echoRadius"><option value="25">25 km</option><option value="50">50 km</option><option value="75">75 km</option><option value="100" selected>100 km</option></select></div>
        <button id="echoAnalyze" type="button">Znajdź najbliższy obszar</button>
      </div>
      <div id="echoPresets" class="echo-presets"></div>
      <div class="echo-results">
        <div class="echo-result"><small>Odległość</small><strong id="echoDistance">—</strong><span>od zaznaczonego punktu</span></div>
        <div class="echo-result"><small>Azymut</small><strong id="echoBearing">—</strong><span id="echoCompass">—</span></div>
        <div class="echo-result"><small id="echoValueLabel">Wartość produktu</small><strong id="echoFoundValue">—</strong><span id="echoFrameTime">—</span></div>
        <div class="echo-result"><small>Współrzędne</small><strong id="echoCoords">—</strong><span>najbliższy obszar ≥ progu</span></div>
        <div class="echo-result"><small id="echoMaxLabel">Maksimum w promieniu</small><strong id="echoMaxValue">—</strong><span id="echoMaxCoords">—</span></div>
        <div class="echo-result"><small>Próg / promień</small><strong id="echoSettings">—</strong><span id="echoSettingsRadius">100 km</span></div>
      </div>
      <div id="echoInfo" class="echo-info">Wybierz aktywną warstwę POLRAD: CMAX, SRI albo PAC 1 h.</div>
    </div>`;
  if (dataCard?.nextSibling) rightColumn.insertBefore(card, dataCard.nextSibling); else rightColumn.appendChild(card);

  if (!map.getPane('analysisMaskPane')) { map.createPane('analysisMaskPane'); map.getPane('analysisMaskPane').style.zIndex='460'; map.getPane('analysisMaskPane').style.pointerEvents='none'; }
  if (!map.getPane('analysisResultPane')) { map.createPane('analysisResultPane'); map.getPane('analysisResultPane').style.zIndex='645'; map.getPane('analysisResultPane').style.pointerEvents='none'; }

  let analysisCircle=null,analysisMask=null,resultLine=null,resultMarker=null,shortPress=null,rasterCache=null;
  const hiddenBaseRings=[];

  function activeProduct(){for(const p of ['cmax','sri','pac'])if($('polrad_'+p)?.classList.contains('active'))return p;return null;}
  function fmtNum(v,p){if(!Number.isFinite(Number(v)))return'—';const n=Number(v);if(p==='cmax')return Math.round(n).toString();if(n<1)return n.toFixed(1).replace('.',',');if(Math.abs(n-Math.round(n))<.05)return Math.round(n).toString();return n.toFixed(1).replace('.',',');}
  function formatThreshold(v,p){return fmtNum(v,p)+' '+PROFILES[p].unit;}
  function haversineKm(a,b){const R=6371.0088,p1=toRad(a.lat),p2=toRad(b.lat),dp=toRad(b.lat-a.lat),dl=toRad(b.lon-a.lon),h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));}
  function initialBearing(a,b){const p1=toRad(a.lat),p2=toRad(b.lat),dl=toRad(b.lon-a.lon),y=Math.sin(dl)*Math.cos(p2),x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);return(toDeg(Math.atan2(y,x))+360)%360;}
  function compass16(deg){const d=['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];return d[Math.round((((deg%360)+360)%360)/22.5)%16];}
  function destination(c,b,d){const R=6371.0088,br=toRad(b),p1=toRad(c.lat),l1=toRad(c.lon),dr=d/R,p2=Math.asin(Math.sin(p1)*Math.cos(dr)+Math.cos(p1)*Math.sin(dr)*Math.cos(br)),l2=l1+Math.atan2(Math.sin(br)*Math.sin(dr)*Math.cos(p1),Math.cos(dr)-Math.sin(p1)*Math.sin(p2));return{lat:toDeg(p2),lon:((toDeg(l2)+540)%360)-180};}

  function rgbToHsv(r,g,b){r/=255;g/=255;b/=255;const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;let h=0;if(d){if(max===r)h=60*(((g-b)/d)%6);else if(max===g)h=60*((b-r)/d+2);else h=60*((r-g)/d+4);}if(h<0)h+=360;return{h,s:max?d/max:0,v:max};}
  function cmaxClass(r,g,b,a){if(a<24)return null;const{h,s,v}=rgbToHsv(r,g,b);if(s<.28||v<.18)return null;if(h>=205&&h<280)return{value:31,lo:27,hi:34,label:'27–34 dBZ'};if(h>=80&&h<205)return{value:40,lo:35,hi:44,label:'35–44 dBZ'};if(h>=18&&h<80)return{value:47,lo:45,hi:49,label:'45–49 dBZ'};if(h<18||h>=348)return{value:52,lo:50,hi:54,label:'50–54 dBZ'};if(h>=280&&h<348)return{value:58,lo:55,hi:65,label:'≥55 dBZ'};return null;}
  function hydroClass(r,g,b,a,unit){if(a<24)return null;const{h,s,v}=rgbToHsv(r,g,b);if(v<.16)return null;let value=null;if(s<.16&&v>.78)value=1;else if(h>=220&&h<285){if(v<.48)value=.1;else if(v<.72)value=.2;else value=.3;}else if(h>=185&&h<220)value=.6;else if(h>=75&&h<185)value=1;else if(h>=50&&h<75)value=s<.60?1.7:3.1;else if(h>=36&&h<50)value=5.4;else if(h>=18&&h<36)value=9.6;else if(h<18||h>=350)value=v<.62?30:17;else if(h>=285&&h<350)value=30;if(value===null)return null;return{value,lo:value,hi:value>=30?999:value,label:(value>=30?'>30':String(value).replace('.',','))+' '+unit};}
  function classifyPixel(p,r,g,b,a){return p==='cmax'?cmaxClass(r,g,b,a):hydroClass(r,g,b,a,PROFILES[p].unit);}
  function meets(cls,threshold,p){return!!cls&&(p==='cmax'?cls.hi>=threshold:cls.value>=threshold);}

  function visibleProductImage(p){const imgs=[...map.getContainer().querySelectorAll('.leaflet-overlay-pane img.leaflet-image-layer')];const exact=imgs.find(img=>{if(!img.complete||img.naturalWidth<2||getComputedStyle(img).display==='none')return false;const src=(img.currentSrc||img.src||'').toLowerCase();return src.includes('/'+p+'/')||src.includes('_'+p+'.')||src.includes('/'+p+'.');});if(exact)return exact;const visible=imgs.filter(img=>img.complete&&img.naturalWidth>1&&getComputedStyle(img).display!=='none');return visible.length===1?visible[0]:null;}
  function imageGeometry(img){const ir=img.getBoundingClientRect(),mr=map.getContainer().getBoundingClientRect();if(ir.width<2||ir.height<2)throw new Error('Aktywna warstwa POLRAD nie ma prawidłowej geometrii.');return{ir,mr};}
  function frameLabel(p){const text=($('radarTime')?.textContent||'').trim();return text?text.replace(new RegExp('^'+p.toUpperCase()+':\\s*','i'),''):'aktualna klatka';}
  async function getRaster(){const p=activeProduct();if(!p)throw new Error('Włącz jedną warstwę POLRAD: CMAX, SRI albo PAC 1 h.');let img=null;for(let i=0;i<20;i++){img=visibleProductImage(p);if(img)break;await sleep(80);}if(!img)throw new Error('Nie znaleziono obrazu aktywnej warstwy POLRAD '+p.toUpperCase()+'.');const key=p+'|'+(img.currentSrc||img.src)+'|'+img.naturalWidth+'x'+img.naturalHeight;if(rasterCache?.key===key){rasterCache.geo=imageGeometry(img);return rasterCache;}const canvas=document.createElement('canvas');canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;const ctx=canvas.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0);let rgba;try{rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data;}catch(_){throw new Error('Przeglądarka zablokowała odczyt pikseli aktywnej warstwy POLRAD (CORS).');}return rasterCache={key,product:p,width:canvas.width,height:canvas.height,rgba,geo:imageGeometry(img),label:frameLabel(p)};}
  function naturalForLatLng(r,ll){const cp=map.latLngToContainerPoint([ll.lat,ll.lon??ll.lng]),clientX=r.geo.mr.left+cp.x,clientY=r.geo.mr.top+cp.y;return{x:(clientX-r.geo.ir.left)/r.geo.ir.width*r.width,y:(clientY-r.geo.ir.top)/r.geo.ir.height*r.height};}
  function latLngForNatural(r,x,y){const clientX=r.geo.ir.left+((x+.5)/r.width)*r.geo.ir.width,clientY=r.geo.ir.top+((y+.5)/r.height)*r.geo.ir.height,cp=L.point(clientX-r.geo.mr.left,clientY-r.geo.mr.top),ll=map.containerPointToLatLng(cp);return{lat:ll.lat,lon:ll.lng};}
  function classAtPixel(r,x,y){x=Math.round(x);y=Math.round(y);if(x<0||y<0||x>=r.width||y>=r.height)return null;const i=(y*r.width+x)*4;return classifyPixel(r.product,r.rgba[i],r.rgba[i+1],r.rgba[i+2],r.rgba[i+3]);}
  function classAtLatLng(r,ll){const p=naturalForLatLng(r,ll),classes=[];for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const c=classAtPixel(r,p.x+dx,p.y+dy);if(c)classes.push(c);}if(!classes.length)return null;classes.sort((a,b)=>b.value-a.value);return classes[0];}

  function hideBaseRings(){hiddenBaseRings.length=0;map.eachLayer(layer=>{if(layer instanceof L.Circle&&!(layer instanceof L.CircleMarker)&&layer!==analysisCircle&&layer.options?.pane!=='analysisResultPane'&&String(layer.options?.dashArray||'').includes('4')){hiddenBaseRings.push({layer,opacity:layer.options.opacity,fillOpacity:layer.options.fillOpacity});layer.setStyle({opacity:0,fillOpacity:0});}});}
  function restoreBaseRings(){for(const x of hiddenBaseRings){try{x.layer.setStyle({opacity:x.opacity??1,fillOpacity:x.fillOpacity??0});}catch(_){}}hiddenBaseRings.length=0;}
  function clearAnalysis(restore=true){for(const layer of[analysisCircle,analysisMask,resultLine,resultMarker])if(layer&&map.hasLayer(layer))map.removeLayer(layer);analysisCircle=analysisMask=resultLine=resultMarker=null;if(restore)restoreBaseRings();}
  function ring(c,r,count=96){const out=[];for(let i=0;i<count;i++){const p=destination(c,i*360/count,r);out.push([p.lat,p.lon]);}return out;}
  function focusCircle(c,r){clearAnalysis(false);restoreBaseRings();hideBaseRings();const inner=ring(c,r),outer=[[-85,-180],[-85,180],[85,180],[85,-180]];analysisMask=L.polygon([outer,inner.slice().reverse()],{pane:'analysisMaskPane',stroke:false,fillColor:'#05070a',fillOpacity:.42,interactive:false}).addTo(map);analysisCircle=L.circle([c.lat,c.lon],{pane:'analysisResultPane',radius:r*1000,color:'#8fa2ff',weight:2,fill:false,dashArray:'6 5',interactive:false}).addTo(map);map.fitBounds(analysisCircle.getBounds(),{padding:[24,24]});}
  async function waitForMap(){await new Promise(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;map.off('moveend',finish);resolve();};map.once('moveend',finish);setTimeout(finish,650);});await sleep(120);}

  function resetResults(){for(const id of['echoDistance','echoBearing','echoFoundValue','echoCoords','echoMaxValue'])$(id).textContent='—';$('echoCompass').textContent='—';$('echoFrameTime').textContent='—';$('echoMaxCoords').textContent='—';}
  function syncProductUi(){const p=activeProduct(),pr=p?PROFILES[p]:null;rasterCache=null;clearAnalysis();if(!pr){$('echoHeading').textContent='Analiza POLRAD';$('echoThresholdLabel').textContent='Próg';$('echoPresets').innerHTML='';$('echoAnalyze').disabled=true;$('echoInfo').textContent='Wybierz aktywną warstwę POLRAD: CMAX, SRI albo PAC 1 h.';resetResults();return;}$('echoHeading').textContent=pr.title;$('echoThresholdLabel').textContent=pr.thresholdLabel;const inp=$('echoThreshold');inp.min=pr.min;inp.max=pr.max;inp.step=pr.step;inp.value=lastThreshold[p];$('echoAnalyze').disabled=false;$('echoValueLabel').textContent=pr.valueName;$('echoMaxLabel').textContent='Maksimum '+pr.valueName.toLowerCase()+' w promieniu';$('echoSettings').textContent=formatThreshold(lastThreshold[p],p);$('echoPresets').innerHTML=pr.presets.map(([v,label])=>'<button type="button" data-v="'+v+'">'+label+'</button>').join('');$('echoPresets').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{inp.value=b.dataset.v;lastThreshold[p]=Number(b.dataset.v);analyze();}));$('echoInfo').textContent=p==='cmax'?'Analizowana jest aktualnie widoczna klatka CMAX. Odbiciowość jest raportowana jako klasa legendy obrazu.':p==='sri'?'Analizowana jest aktualnie widoczna klatka SRI. Skala produktu: natężenie opadu w mm/h.':'Analizowana jest aktualnie widoczna klatka PAC 1 h. Skala produktu: suma opadu z 1 godziny w mm.';resetResults();setTimeout(updatePointProduct,350);}

  function metricLabelsFor(p){const pr=PROFILES[p],metric=$('dbz')?.closest('.metric');if(metric)metric.querySelector('small').textContent=pr.pointLabel;const trendMetric=$('dbzTrend')?.closest('.metric');if(trendMetric){trendMetric.querySelector('small').textContent=pr.trendLabel;const span=trendMetric.querySelector('span');if(span)span.textContent='historia aktywnej warstwy — w przygotowaniu';}if($('dbzTrend'))$('dbzTrend').textContent='—';}
  async function updatePointProduct(){const p=activeProduct();if(!p||typeof point==='undefined')return;metricLabelsFor(p);try{const r=await getRaster(),cls=classAtLatLng(r,{lat:Number(point.lat),lon:Number(point.lon)}),val=$('dbz'),note=$('dbzNote');if(val)val.textContent=cls?cls.label:'brak sygnału';if(note)note.textContent=PROFILES[p].note+' · '+r.label;}catch(_){}}

  async function analyze(){const p=activeProduct(),pr=p?PROFILES[p]:null,info=$('echoInfo');if(!pr){syncProductUi();return;}const raw=Number($('echoThreshold').value),threshold=clamp(Number.isFinite(raw)?raw:pr.def,pr.min,pr.max);lastThreshold[p]=threshold;$('echoThreshold').value=threshold;const radius=clamp(Number($('echoRadius').value)||100,5,100);$('echoSettings').textContent=formatThreshold(threshold,p);$('echoSettingsRadius').textContent=radius+' km';resetResults();info.classList.remove('error');info.textContent='Analizuję aktywną warstwę '+p.toUpperCase()+' wyłącznie w promieniu '+radius+' km…';try{if(typeof point==='undefined'||!Number.isFinite(Number(point.lat))||!Number.isFinite(Number(point.lon)))throw new Error('Brak prawidłowego punktu odniesienia.');const center={lat:Number(point.lat),lon:Number(point.lon)};focusCircle(center,radius);await waitForMap();rasterCache=null;const r=await getRaster();await updatePointProduct();const pc=naturalForLatLng(r,center),pe=naturalForLatLng(r,destination(center,90,radius)),pn=naturalForLatLng(r,destination(center,0,radius)),rx=Math.abs(pe.x-pc.x),ry=Math.abs(pn.y-pc.y);if(rx<2||ry<2)throw new Error('Za mała rozdzielczość obrazu do analizy wybranego promienia.');const x0=Math.max(0,Math.floor(pc.x-rx)),x1=Math.min(r.width-1,Math.ceil(pc.x+rx)),y0=Math.max(0,Math.floor(pc.y-ry)),y1=Math.min(r.height-1,Math.ceil(pc.y+ry)),stride=Math.max(1,Math.floor(Math.max(rx,ry)/260)),qualified=[],qset=new Set();let maximum=null,row=0;for(let y=y0;y<=y1;y+=stride){const ny=(y-pc.y)/ry;for(let x=x0;x<=x1;x+=stride){const nx=(x-pc.x)/rx;if(nx*nx+ny*ny>1)continue;const cls=classAtPixel(r,x,y);if(!cls)continue;const ll=latLngForNatural(r,x,y),dist=haversineKm(center,ll);if(dist>radius*1.02)continue;const item={x,y,gx:Math.round((x-x0)/stride),gy:Math.round((y-y0)/stride),cls,ll,dist};if(!maximum||cls.value>maximum.cls.value||(cls.value===maximum.cls.value&&dist<maximum.dist))maximum=item;if(meets(cls,threshold,p)){qualified.push(item);qset.add(item.gx+','+item.gy);}}if((++row%18)===0)await sleep(0);}let nearest=null;const coherent=item=>{let n=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;if(qset.has((item.gx+dx)+','+(item.gy+dy)))n++;}return n>=1;};for(const item of qualified){if(qualified.length>2&&!coherent(item))continue;if(!nearest||item.dist<nearest.dist)nearest=item;}if(!nearest&&qualified.length)nearest=qualified.reduce((a,b)=>!a||b.dist<a.dist?b:a,null);$('echoFrameTime').textContent=r.label;if(maximum){$('echoMaxValue').textContent=maximum.cls.label;$('echoMaxCoords').textContent=maximum.ll.lat.toFixed(4)+', '+maximum.ll.lon.toFixed(4);}else{$('echoMaxValue').textContent='brak';$('echoMaxCoords').textContent='brak rozpoznanego sygnału';}if(!nearest){$('echoDistance').textContent='brak';info.textContent='W promieniu '+radius+' km nie znaleziono obszaru '+pr.valueName.toLowerCase()+' ≥ '+formatThreshold(threshold,p)+'. Maksimum rozpoznane: '+(maximum?maximum.cls.label:'brak')+'.';return;}const bearing=initialBearing(center,nearest.ll),dir=compass16(bearing);$('echoDistance').textContent=nearest.dist<10?nearest.dist.toFixed(1)+' km':nearest.dist.toFixed(0)+' km';$('echoBearing').textContent=Math.round(bearing)+'°';$('echoCompass').textContent=dir+' · azymut od punktu';$('echoFoundValue').textContent=nearest.cls.label;$('echoCoords').textContent=nearest.ll.lat.toFixed(4)+', '+nearest.ll.lon.toFixed(4);resultLine=L.polyline([[center.lat,center.lon],[nearest.ll.lat,nearest.ll.lon]],{pane:'analysisResultPane',color:'#ff5b52',weight:2,dashArray:'7 5',interactive:false}).addTo(map);resultMarker=L.circleMarker([nearest.ll.lat,nearest.ll.lon],{pane:'analysisResultPane',radius:6,color:'#ff5b52',weight:2,fillColor:'#fff',fillOpacity:1,interactive:false}).addTo(map);info.textContent='Znaleziono najbliższy obszar '+pr.valueName.toLowerCase()+' ≥ '+formatThreshold(threshold,p)+' w aktywnej warstwie '+p.toUpperCase()+'.';}catch(e){info.classList.add('error');info.textContent='Analiza nie powiodła się: '+(e?.message||e);}}

  async function showClickedValue(ll){const p=activeProduct(),pr=p?PROFILES[p]:null;if(!pr){L.popup().setLatLng(ll).setContent('<div class="radar-click-popup">Wybierz CMAX, SRI albo PAC 1 h.</div>').openOn(map);return;}try{const r=await getRaster(),cls=classAtLatLng(r,{lat:ll.lat,lon:ll.lng}),value=cls?cls.label:'brak sygnału';L.popup({closeButton:true,autoPan:true}).setLatLng(ll).setContent('<div class="radar-click-popup"><b>'+value+'</b><br>'+pr.note+' · '+r.label+'<br><small>'+ll.lat.toFixed(4)+', '+ll.lng.toFixed(4)+'</small></div>').openOn(map);}catch(e){L.popup().setLatLng(ll).setContent('<div class="radar-click-popup">Nie udało się odczytać aktywnej warstwy.<br><small>'+(e?.message||e)+'</small></div>').openOn(map);}}

  const mapEl=$('map');
  if(mapEl){mapEl.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse'&&e.button!==0)return;shortPress={id:e.pointerId,x:e.clientX,y:e.clientY,t:performance.now()};},{capture:true,passive:true});mapEl.addEventListener('pointermove',e=>{if(!shortPress||shortPress.id!==e.pointerId)return;if(Math.hypot(e.clientX-shortPress.x,e.clientY-shortPress.y)>12)shortPress=null;},{capture:true,passive:true});mapEl.addEventListener('pointerup',e=>{if(!shortPress||shortPress.id!==e.pointerId)return;const s=shortPress;shortPress=null;if(performance.now()-s.t>650)return;const rect=mapEl.getBoundingClientRect(),ll=map.containerPointToLatLng(L.point(e.clientX-rect.left,e.clientY-rect.top));showClickedValue(ll);},{capture:true,passive:true});mapEl.addEventListener('pointercancel',()=>{shortPress=null;},{capture:true,passive:true});}

  $('echoAnalyze')?.addEventListener('click',analyze);
  $('echoThreshold')?.addEventListener('keydown',e=>{if(e.key==='Enter')analyze();});
  $('echoThreshold')?.addEventListener('change',()=>{const p=activeProduct();if(p)lastThreshold[p]=Number($('echoThreshold').value)||PROFILES[p].def;});
  const onContextChanged=()=>{rasterCache=null;clearAnalysis();setTimeout(syncProductUi,220);setTimeout(updatePointProduct,900);};
  for(const p of['cmax','sri','pac'])$('polrad_'+p)?.addEventListener('click',onContextChanged);
  $('radarToggle')?.addEventListener('click',onContextChanged);
  $('apply')?.addEventListener('click',()=>setTimeout(()=>{rasterCache=null;clearAnalysis();updatePointProduct();},300));
  $('resetPoint')?.addEventListener('click',()=>setTimeout(()=>{rasterCache=null;clearAnalysis();updatePointProduct();},300));
  $('radarFrame')?.addEventListener('input',()=>{rasterCache=null;setTimeout(updatePointProduct,220);});
  setTimeout(syncProductUi,700);
})();
