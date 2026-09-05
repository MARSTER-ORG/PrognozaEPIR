'use strict';
(() => {
  if (typeof L === 'undefined' || typeof map === 'undefined' || !map) return;
  const byId=id=>document.getElementById(id);
  const version=document.querySelector('.brand small');if(version)version.textContent='RADAR / SAT / AI v0.11.4';
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

  function removeLegacyLi(){
    map.eachLayer(layer=>{try{if(layer?.options?.layers==='mtg_fd:li_afa')map.removeLayer(layer)}catch(_){}});
  }
  function bbox3857(){
    const b=map.getBounds(),sw=L.CRS.EPSG3857.project(b.getSouthWest()),ne=L.CRS.EPSG3857.project(b.getNorthEast());
    return {minX:sw.x,minY:sw.y,maxX:ne.x,maxY:ne.y};
  }
  function imageUrl(box,w=512,h=512){
    const q=new URLSearchParams({service:'WMS',request:'GetMap',version:'1.1.1',layers:'mtg_fd:li_afa',styles:'',format:'image/png',transparent:'true',srs:'EPSG:3857',bbox:[box.minX,box.minY,box.maxX,box.maxY].join(','),width:String(w),height:String(h)});
    q.set('_ts',String(Date.now()));return WMS+'?'+q;
  }
  function loadImage(url){
    return new Promise((resolve,reject)=>{const img=new Image();img.crossOrigin='anonymous';img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('błąd pobierania MTG LI'));img.src=url});
  }
  function isSignal(r,g,b,a){if(a<20)return false;const max=Math.max(r,g,b),min=Math.min(r,g,b);return max>45&&(max-min)>18}
  function projectedToLatLng(x,y){return L.CRS.EPSG3857.unproject(L.point(x,y))}

  async function extractBolts(img,box){
    const W=512,H=512,c=document.createElement('canvas');c.width=W;c.height=H;
    const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0,W,H);
    let data;try{data=ctx.getImageData(0,0,W,H).data}catch(_){throw new Error('serwer WMS nie pozwolił odczytać obrazu do symboli')}
    const block=4,gw=Math.ceil(W/block),gh=Math.ceil(H/block),occ=new Uint8Array(gw*gh);
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
      while(stack.length){
        const [x,y]=stack.pop();sx+=x;sy+=y;n++;
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
          if(!dx&&!dy)continue;const nx=x+dx,ny=y+dy;if(nx<0||ny<0||nx>=gw||ny>=gh)continue;
          const k=ny*gw+nx;if(occ[k]&&!seen[k]){seen[k]=1;stack.push([nx,ny])}
        }
      }
      if(n>=1)comps.push({x:sx/n,y:sy/n,n});
    }
    comps.sort((a,b)=>b.n-a.n);
    const chosen=comps.slice(0,240),out=[];
    for(const c0 of chosen){
      const px=(c0.x+.5)*block,py=(c0.y+.5)*block,fx=px/W,fy=py/H;
      const x=box.minX+fx*(box.maxX-box.minX),y=box.maxY-fy*(box.maxY-box.minY),ll=projectedToLatLng(x,y);
      out.push({lat:ll.lat,lng:ll.lng,size:c0.n});
    }
    return out;
  }

  async function refresh(){
    if(!active)return;const seq=++requestSeq;setStatus('Wyładowania: pobieranie najnowszej akumulacji MTG LI i zamiana na symbole ⚡…');
    try{
      const box=bbox3857(),img=await loadImage(imageUrl(box)),points=await extractBolts(img,box);
      if(seq!==requestSeq||!active)return;icons.clearLayers();
      for(const p of points)L.marker([p.lat,p.lng],{icon:boltIcon,pane:'lightningIconsPane',interactive:false,keyboard:false}).addTo(icons);
      const now=new Intl.DateTimeFormat('pl-PL',{timeZone:'Europe/Warsaw',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date());
      setStatus('Wyładowania: '+points.length+' obszarów aktywności · MTG Lightning Imager AFA, akumulacja 5 min · odświeżono '+now+'. Symbole ⚡ oznaczają centroidy obszarów aktywności, nie pojedyncze wyładowania PERUN.');
    }catch(e){
      if(seq!==requestSeq)return;icons.clearLayers();setStatus('Wyładowania: nie udało się utworzyć symboli ⚡ ('+(e?.message||e)+'). Spróbuj ponownie za chwilę.');
    }
  }
  function scheduleRefresh(ms=250){clearTimeout(moveTimer);moveTimer=setTimeout(refresh,ms)}
  button.addEventListener('click',()=>{
    active=!active;button.classList.toggle('active',active);removeLegacyLi();
    if(active){icons.addTo(map);refresh()}else{requestSeq++;icons.clearLayers();if(map.hasLayer(icons))map.removeLayer(icons);setStatus('',false)}
  });
  map.on('moveend zoomend',()=>{if(active)scheduleRefresh(300)});
  setInterval(()=>{if(active)refresh()},60000);

  const sources=document.querySelector('.sources');
  if(sources&&!byId('srcLightningLive')){
    const row=document.createElement('div');
    row.innerHTML='<span id="srcLightningLive" class="dot ok"></span>Wyładowania: EUMETSAT MTG Lightning Imager — symbole ⚡ z obszarów LI AFA (5 min)';
    sources.prepend(row);
  }
})();
