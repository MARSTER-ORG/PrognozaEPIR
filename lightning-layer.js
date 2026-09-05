'use strict';
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;
  const byId=id=>document.getElementById(id);
  const version=document.querySelector('.brand small');if(version)version.textContent='RADAR / SAT / AI v0.12.0';
  const mapbar=document.querySelector('.mapbar');if(!mapbar)return;

  const oldLi=byId('mtgLiToggle');if(oldLi)oldLi.style.display='none';
  if(!map.getPane('lightningIconsPane')){
    map.createPane('lightningIconsPane');
    map.getPane('lightningIconsPane').style.zIndex='665';
    map.getPane('lightningIconsPane').style.pointerEvents='none';
  }
  const style=document.createElement('style');
  style.textContent=`.lightning-bolt{font-size:14px;line-height:14px;width:14px;height:14px;text-align:center;color:#ffd400;text-shadow:0 0 1px #000,0 0 3px #000;font-weight:700;transform:translate(-1px,-1px)}`;
  document.head.appendChild(style);

  let button=byId('lightningToggle');
  if(!button){
    button=document.createElement('button');button.id='lightningToggle';button.type='button';button.textContent='⚡ Wyładowania';
    button.title='EUMETSAT MTG Lightning Imager — obszary aktywności z najnowszej akumulacji 5 min';
    const before=byId('hazardsToggle')||byId('playRadar')||null;before?mapbar.insertBefore(button,before):mapbar.appendChild(button);
  }
  let status=byId('lightningStatus');
  if(!status){
    status=document.createElement('div');status.id='lightningStatus';status.className='polrad-note';status.style.display='none';
    const p=byId('polradStatus');p?p.insertAdjacentElement('afterend',status):mapbar.insertAdjacentElement('afterend',status);
  }
  const setStatus=(t,show=true)=>{status.textContent=t;status.style.display=show?'block':'none'};
  const icons=L.layerGroup();let active=false,moveTimer=null,requestSeq=0;
  const boltIcon=L.divIcon({className:'',html:'<div class="lightning-bolt">⚡</div>',iconSize:[14,14],iconAnchor:[7,7]});
  const WMS='https://view.eumetsat.int/geoserver/wms';
  let latestPoints=[],latestUpdatedAt=0,aroundCache=null;

  function removeLegacyLi(){map.eachLayer(layer=>{try{if(layer?.options?.layers==='mtg_fd:li_afa')map.removeLayer(layer)}catch(_){}});}
  function boxFromBounds(bounds){return{west:bounds.getWest(),south:bounds.getSouth(),east:bounds.getEast(),north:bounds.getNorth()};}
  function boxAround(center,radiusKm){
    const dLat=radiusKm/111.32,cos=Math.max(.15,Math.cos(Number(center.lat)*Math.PI/180)),dLon=radiusKm/(111.32*cos);
    return{west:Number(center.lon)-dLon,south:Number(center.lat)-dLat,east:Number(center.lon)+dLon,north:Number(center.lat)+dLat};
  }
  function imageUrl(box,w=640,h=640){
    const q=new URLSearchParams({service:'WMS',request:'GetMap',version:'1.1.1',layers:'mtg_fd:li_afa',styles:'',format:'image/png',transparent:'true',srs:'EPSG:4326',bbox:[box.west,box.south,box.east,box.north].join(','),width:String(w),height:String(h)});
    q.set('_ts',String(Math.floor(Date.now()/60000)));return WMS+'?'+q;
  }
  function loadImage(url){return new Promise((resolve,reject)=>{const img=new Image();img.crossOrigin='anonymous';img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('błąd pobierania MTG LI'));img.src=url});}

  // EUMETSAT documents that LI AFA pixels without flashes are transparent.
  // Therefore alpha is the primary discriminator; colour is only a sanity check.
  function isSignal(r,g,b,a){return a>=16&&Math.max(r,g,b)>=6;}
  async function extractPoints(img,box,W=640,H=640){
    const c=document.createElement('canvas');c.width=W;c.height=H;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0,W,H);
    let data;try{data=ctx.getImageData(0,0,W,H).data}catch(_){throw new Error('serwer WMS nie pozwolił odczytać obrazu LI')}
    const block=3,gw=Math.ceil(W/block),gh=Math.ceil(H/block),occ=new Uint8Array(gw*gh);
    for(let gy=0;gy<gh;gy++)for(let gx=0;gx<gw;gx++){
      let hit=false;
      for(let yy=0;yy<block&&!hit;yy++)for(let xx=0;xx<block;xx++){
        const x=gx*block+xx,y=gy*block+yy;if(x>=W||y>=H)continue;const p=(y*W+x)*4;
        if(isSignal(data[p],data[p+1],data[p+2],data[p+3])){hit=true;break}
      }
      if(hit)occ[gy*gw+gx]=1;
    }
    const seen=new Uint8Array(gw*gh),comps=[];
    for(let gy=0;gy<gh;gy++)for(let gx=0;gx<gw;gx++){
      const start=gy*gw+gx;if(!occ[start]||seen[start])continue;
      const stack=[[gx,gy]];seen[start]=1;let sx=0,sy=0,n=0;
      while(stack.length){const [x,y]=stack.pop();sx+=x;sy+=y;n++;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        if(!dx&&!dy)continue;const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=gw||ny>=gh)continue;const k=ny*gw+nx;if(occ[k]&&!seen[k]){seen[k]=1;stack.push([nx,ny]);}
      }}
      if(n>=1)comps.push({x:sx/n,y:sy/n,n});
    }
    comps.sort((a,b)=>b.n-a.n);const out=[];
    for(const c0 of comps.slice(0,350)){
      const fx=((c0.x+.5)*block)/W,fy=((c0.y+.5)*block)/H;
      out.push({lat:box.north-fy*(box.north-box.south),lng:box.west+fx*(box.east-box.west),size:c0.n});
    }
    return out;
  }
  async function fetchBox(box){const img=await loadImage(imageUrl(box));const points=await extractPoints(img,box);return{points,updatedAt:Date.now(),source:'EUMETSAT MTG LI AFA'};}
  function publish(points,updatedAt){latestPoints=points.slice();latestUpdatedAt=updatedAt;window.dispatchEvent(new CustomEvent('prognozaepir:lightning',{detail:{points:latestPoints.slice(),updatedAt,source:'EUMETSAT MTG LI AFA'}}));}

  async function getPointsAround(center,radiusKm=100){
    const c={lat:Number(center?.lat),lon:Number(center?.lon??center?.lng)};if(!Number.isFinite(c.lat)||!Number.isFinite(c.lon))throw new Error('nieprawidłowy punkt analizy LI');
    const key=c.lat.toFixed(2)+','+c.lon.toFixed(2)+'|'+radiusKm+'|'+Math.floor(Date.now()/55000);if(aroundCache?.key===key)return aroundCache.value;
    const value=await fetchBox(boxAround(c,radiusKm));aroundCache={key,value};window.dispatchEvent(new CustomEvent('prognozaepir:lightning-analysis',{detail:value}));return value;
  }

  async function refresh(){
    if(!active)return;const seq=++requestSeq;setStatus('Wyładowania: pobieranie MTG LI…');
    try{
      const value=await fetchBox(boxFromBounds(map.getBounds()));if(seq!==requestSeq||!active)return;icons.clearLayers();
      for(const p of value.points)L.marker([p.lat,p.lng],{icon:boltIcon,pane:'lightningIconsPane',interactive:false,keyboard:false}).addTo(icons);
      publish(value.points,value.updatedAt);
      const now=new Intl.DateTimeFormat('pl-PL',{timeZone:'Europe/Warsaw',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(value.updatedAt));
      setStatus('Wyładowania: '+value.points.length+' obszarów LI AFA · odświeżono '+now+'. Symbole ⚡ oznaczają centroidy obszarów aktywności.');
    }catch(e){if(seq!==requestSeq)return;icons.clearLayers();setStatus('Wyładowania: błąd MTG LI ('+(e?.message||e)+').');}
  }
  function scheduleRefresh(ms=250){clearTimeout(moveTimer);moveTimer=setTimeout(refresh,ms)}
  button.addEventListener('click',()=>{active=!active;button.classList.toggle('active',active);removeLegacyLi();if(active){icons.addTo(map);refresh()}else{requestSeq++;icons.clearLayers();if(map.hasLayer(icons))map.removeLayer(icons);setStatus('',false)}});
  map.on('moveend zoomend',()=>{if(active)scheduleRefresh(300)});setInterval(()=>{if(active)refresh()},60000);

  window.PrognozaEPIRLightning={
    getPoints:()=>latestPoints.slice(),
    getUpdatedAt:()=>latestUpdatedAt,
    getPointsAround,
    refresh,
    isActive:()=>active
  };

  const sources=document.querySelector('.sources');if(sources&&!byId('srcLightningLive')){const row=document.createElement('div');row.innerHTML='<span id="srcLightningLive" class="dot ok"></span>Wyładowania: EUMETSAT MTG Lightning Imager — LI AFA 5 min';sources.prepend(row);}
})();
