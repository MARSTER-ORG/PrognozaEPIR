from pathlib import Path

p = Path('opera-nowcast.js')
s = p.read_text(encoding='utf-8')

def rep(old,new,label):
    global s
    if new in s:
        return
    if old not in s:
        raise SystemExit(f'missing anchor: {label}')
    s=s.replace(old,new,1)

rep("  const SYNC_TOLERANCE_MIN = 7.5;\n", "  const SYNC_TOLERANCE_MIN = 7.5;\n  const WEB_MERCATOR_R = 6378137;\n  const WEB_MERCATOR_MAX_LAT = 85.05112878;\n  const OPERA_RENDER_MAX_N = 241;\n", 'render constants')

rep("  let operaFrameHistory=[];\n  let lastPolradFrame=null;\n", "  let operaFrameHistory=[];\n  let lastPolradFrame=null;\n  const operaRenderCache=new Map();\n", 'render cache')

old_return="    return{time:frame.time,url:frame.url,values,mask,active,mean:active?sum/active:NaN,max,area,operational,scout,qMean,qUsable,projection:pp.name,geoBounds};\n"
new_return="    return{time:frame.time,url:frame.url,values,width:GRID_N,height:GRID_N,mask,active,mean:active?sum/active:NaN,max,area,operational,scout,qMean,qUsable,projection:pp.name,proj:pp.proj,projectedBounds:{x0:wx0,x1:wx1,yTop:wyTop,yBottom:wyBottom},geoBounds};\n"
rep(old_return,new_return,'readFrame projected metadata')

old_block="""  function colorForDbz(v){if(!finite(v)||v<5)return[0,0,0,0];const p=[[62,245,140,255],[56,255,25,204],[50,230,0,89],[44,255,22,0],[38,255,136,0],[32,255,242,0],[26,255,251,216],[20,184,244,241],[14,27,200,240],[8,0,51,232],[5,0,0,204]];for(const x of p)if(v>=x[0])return[x[1],x[2],x[3],185];return[0,0,170,150]}
  function rasterDataUrl(latest){const c=document.createElement('canvas');c.width=GRID_N;c.height=GRID_N;const ctx=c.getContext('2d');if(!ctx)return null;const im=ctx.createImageData(GRID_N,GRID_N);for(let i=0;i<latest.values.length;i++){const[r,g,b,a]=colorForDbz(Number(latest.values[i])),j=i*4;im.data[j]=r;im.data[j+1]=g;im.data[j+2]=b;im.data[j+3]=a}ctx.putImageData(im,0,0);return c.toDataURL('image/png')}
  function renderMapLayer(latest){
    ensureMapButton();
    if(!mapEnabled||!latest?.geoBounds||typeof L==='undefined'||typeof map==='undefined')return;
    const url=rasterDataUrl(latest);if(!url)return;
    if(!map.getPane('operaSyncPane')){map.createPane('operaSyncPane');map.getPane('operaSyncPane').style.zIndex='475';map.getPane('operaSyncPane').style.pointerEvents='none'}
    if(!operaLayer){
      operaLayer=L.imageOverlay(url,latest.geoBounds,{pane:'operaSyncPane',opacity:.52,interactive:false,attribution:'EUMETNET OPERA CIRRUS'});
      operaLayer.addTo(map);
    }else{
      operaLayer.setBounds(latest.geoBounds);
      operaLayer.setUrl(url);
      if(!map.hasLayer(operaLayer))operaLayer.addTo(map);
    }
  }
"""
new_block="""  function colorForDbz(v){if(!finite(v)||v<5)return[0,0,0,0];const p=[[62,245,140,255],[56,255,25,204],[50,230,0,89],[44,255,22,0],[38,255,136,0],[32,255,242,0],[26,255,251,216],[20,184,244,241],[14,27,200,240],[8,0,51,232],[5,0,0,204]];for(const x of p)if(v>=x[0])return[x[1],x[2],x[3],185];return[0,0,170,150]}
  const mercX=lon=>WEB_MERCATOR_R*Number(lon)*Math.PI/180;
  const mercY=lat=>{const a=clamp(Number(lat),-WEB_MERCATOR_MAX_LAT,WEB_MERCATOR_MAX_LAT)*Math.PI/180;return WEB_MERCATOR_R*Math.log(Math.tan(Math.PI/4+a/2))};
  const mercLon=x=>Number(x)/WEB_MERCATOR_R*180/Math.PI;
  const mercLat=y=>(2*Math.atan(Math.exp(Number(y)/WEB_MERCATOR_R))-Math.PI/2)*180/Math.PI;

  function rasterDataUrl(raster){
    const w=Number(raster?.width)||GRID_N,h=Number(raster?.height)||GRID_N;
    if(!raster?.values||raster.values.length!==w*h)return null;
    const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d');if(!ctx)return null;
    const im=ctx.createImageData(w,h);for(let i=0;i<raster.values.length;i++){const[r,g,b,a]=colorForDbz(Number(raster.values[i])),j=i*4;im.data[j]=r;im.data[j+1]=g;im.data[j+2]=b;im.data[j+3]=a}ctx.putImageData(im,0,0);return c.toDataURL('image/png')
  }

  function reprojectForLeaflet(raster){
    if(!raster?.geoBounds)return null;
    const srcW=Number(raster.width)||GRID_N,srcH=Number(raster.height)||GRID_N;
    const pb=raster.projectedBounds,srcProj=raster.proj;
    if(!pb||!srcProj||!raster.values||raster.values.length!==srcW*srcH){const url=rasterDataUrl(raster);return url?{url,bounds:raster.geoBounds,reprojected:false}:null}
    const key=`${Number(raster.time)||0}:${srcW}x${srcH}:${srcProj}`;
    if(operaRenderCache.has(key))return operaRenderCache.get(key);
    const south=Number(raster.geoBounds[0][0]),west=Number(raster.geoBounds[0][1]),north=Number(raster.geoBounds[1][0]),east=Number(raster.geoBounds[1][1]);
    if(![south,west,north,east].every(finite))return null;
    const mx0=mercX(west),mx1=mercX(east),my0=mercY(south),my1=mercY(north);
    const outW=Math.min(srcW,OPERA_RENDER_MAX_N),outH=Math.min(srcH,OPERA_RENDER_MAX_N),out=new Float32Array(outW*outH);out.fill(NaN);
    const sxDen=Number(pb.x1)-Number(pb.x0),syDen=Number(pb.yTop)-Number(pb.yBottom);if(!finite(sxDen)||!finite(syDen)||sxDen===0||syDen===0)return null;
    for(let y=0;y<outH;y++){
      const my=my1-(y+.5)/outH*(my1-my0),lat=mercLat(my);
      for(let x=0;x<outW;x++){
        const mx=mx0+(x+.5)/outW*(mx1-mx0),lon=mercLon(mx);let q;
        try{q=window.proj4(PROJ_WGS84,srcProj,[lon,lat])}catch(_){continue}
        if(!q||!finite(q[0])||!finite(q[1]))continue;
        const sx=(q[0]-Number(pb.x0))/sxDen*(srcW-1),sy=(Number(pb.yTop)-q[1])/syDen*(srcH-1);
        if(sx<0||sy<0||sx>srcW-1||sy>srcH-1)continue;
        const ix=Math.round(sx),iy=Math.round(sy),v=Number(raster.values[iy*srcW+ix]);if(finite(v))out[y*outW+x]=v;
      }
    }
    const url=rasterDataUrl({values:out,width:outW,height:outH});if(!url)return null;
    const result={url,bounds:[[south,west],[north,east]],reprojected:true,width:outW,height:outH};
    operaRenderCache.set(key,result);while(operaRenderCache.size>24)operaRenderCache.delete(operaRenderCache.keys().next().value);
    return result;
  }

  function renderMapLayer(latest){
    ensureMapButton();
    if(!mapEnabled||!latest?.geoBounds||typeof L==='undefined'||typeof map==='undefined')return;
    const raster=latest.display?.geoBounds?latest.display:latest,visual=reprojectForLeaflet(raster);if(!visual?.url)return;
    if(!map.getPane('operaSyncPane')){map.createPane('operaSyncPane');map.getPane('operaSyncPane').style.zIndex='475';map.getPane('operaSyncPane').style.pointerEvents='none'}
    if(!operaLayer){
      operaLayer=L.imageOverlay(visual.url,visual.bounds,{pane:'operaSyncPane',opacity:.52,interactive:false,attribution:'EUMETNET OPERA CIRRUS'});
      operaLayer.addTo(map);
    }else{
      operaLayer.setBounds(visual.bounds);
      operaLayer.setUrl(visual.url);
      if(!map.hasLayer(operaLayer))operaLayer.addTo(map);
    }
    operaLayer.options.epirReprojected=!!visual.reprojected;
  }
"""
rep(old_block,new_block,'OPERA Web Mercator reprojection')

# Clear stale rendered rasters whenever a fresh OPERA history is loaded.
rep("      operaFrameHistory=grids.slice();\n", "      operaFrameHistory=grids.slice();\n      if(operaRenderCache.size>24)operaRenderCache.clear();\n", 'cache housekeeping')

p.write_text(s,encoding='utf-8')
print('OPERA georeferencing patch applied')
