'use strict';
(() => {
  if (!/\/radar\.html$/i.test(location.pathname)) return;
  if (window.__epirOperaNowcastLoaded) return;
  window.__epirOperaNowcastLoaded = true;

  const API = 'https://api.meteogate.eu/eu-eumetnet-weather-radar/collections/observations/locations/0-20010-0-OPERA';
  const PROJ_OPERA = '+proj=laea +lat_0=55 +lon_0=10 +x_0=1950000 +y_0=-2100000 +ellps=WGS84 +units=m +no_defs';
  const PROJ_WGS84 = '+proj=longlat +datum=WGS84 +no_defs';
  const GEOTIFF_JS = 'https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js';
  const PROJ4_JS = 'https://cdn.jsdelivr.net/npm/proj4@2.22.0/dist/proj4.js';
  const META_CACHE_KEY = 'prognozaepir:opera:frames:v1';
  const META_CACHE_MS = 4 * 60 * 1000;
  const AUTO_MS = 5 * 60 * 1000;
  const FRAME_WINDOW_MIN = 70;
  const MAX_FRAMES = 9;
  const GRID_STEP_KM = 4;
  const GRID_RADIUS_KM = 160;
  const GRID_N = Math.round(GRID_RADIUS_KM * 2 / GRID_STEP_KM) + 1;
  const CENTER = Math.floor(GRID_N / 2);
  const DBZ_THRESHOLD = 27;
  const SEARCH_SHIFT = 6;
  const MAX_FRAME_AGE_MIN = 25;
  const HORIZONS = [15, 30, 45, 60];
  const QIND_MIN = 0.25;

  const $ = id => document.getElementById(id);
  const finite = Number.isFinite;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const median = a => {
    const b = a.filter(finite).sort((x, y) => x - y);
    if (!b.length) return NaN;
    const m = Math.floor(b.length / 2);
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  };
  const circularDiff = (a, b) => {
    if (!finite(a) || !finite(b)) return NaN;
    let d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  };
  const compass16 = deg => {
    if (!finite(deg)) return '—';
    const names = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return names[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
  };
  const bearingFromVector = (east, north) => (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
  const fmtUtcMs = ms => {
    if (!finite(ms)) return '—';
    const d = new Date(ms);
    return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')} UTC`;
  };
  const dbzText = v => finite(v) ? `${Math.round(v)} dBZ` : '—';

  let running = false;
  let lastRun = 0;
  let latestOpera = null;
  let libPromise = null;

  function currentPoint() {
    try {
      if (typeof point !== 'undefined' && finite(Number(point?.lat)) && finite(Number(point?.lon))) {
        return {lat:Number(point.lat), lon:Number(point.lon)};
      }
    } catch (_) {}
    const lat = Number(String($('lat')?.value || '').replace(',','.'));
    const lon = Number(String($('lon')?.value || '').replace(',','.'));
    return finite(lat) && finite(lon) ? {lat, lon} : null;
  }

  function addScript(src, test) {
    if (test()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload = () => test() ? resolve() : reject(new Error('biblioteka nie udostępniła API'));
      s.onerror = () => reject(new Error('nie udało się pobrać biblioteki'));
      document.head.appendChild(s);
    });
  }

  function ensureLibraries() {
    if (libPromise) return libPromise;
    libPromise = (async () => {
      await Promise.all([
        addScript(GEOTIFF_JS, () => !!window.GeoTIFF?.fromUrl),
        addScript(PROJ4_JS, () => typeof window.proj4 === 'function')
      ]);
      return true;
    })();
    return libPromise;
  }

  function ensureUi() {
    if ($('operaNowcastCard')) return;
    const host = $('rnCard') || [...document.querySelectorAll('.card')].find(c => /Radar Nowcast/i.test(c.textContent || ''));
    const card = document.createElement('section');
    card.id = 'operaNowcastCard';
    card.className = 'card w12';
    card.innerHTML = `
      <h2>OPERA CIRRUS · weryfikacja europejska</h2>
      <div class="stats" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        <div><b>Klatka</b><strong id="opFrame">—</strong><small id="opFrames">—</small></div>
        <div><b>Najbliższe ≥27 dBZ</b><strong id="opNearest">—</strong><small id="opNearestSub">—</small></div>
        <div><b>Maksimum ≤160 km</b><strong id="opMax">—</strong><small id="opArea">—</small></div>
        <div><b>Ruch</b><strong id="opMotion">—</strong><small id="opMotionSub">—</small></div>
        <div><b>Trend komórki</b><strong id="opTrend">—</strong><small id="opTrendSub">—</small></div>
        <div><b>Jakość QIND</b><strong id="opQind">—</strong><small id="opQindSub">jeśli band jest dostępny</small></div>
        <div><b>Zgodność z POLRAD</b><strong id="opFusion">—</strong><small id="opFusionSub">—</small></div>
        <div><b>Wsparcie TCU/CB</b><strong id="opConv">—</strong><small id="opConvSub">OPERA nie inicjuje sygnału samodzielnie</small></div>
      </div>
      <div class="note" style="margin-top:8px"><b>OPERA +15/+30/+45/+60 min:</b> <span id="opPred">—</span></div>
      <div id="opSummary" class="note" style="margin-top:5px">Łączenie z EUMETNET Open Radar Data…</div>
      <div id="opStatus" class="note" style="margin-top:4px">—</div>`;
    if (host) host.insertAdjacentElement('afterend', card);
    else document.querySelector('.grid')?.appendChild(card);

    const style = document.createElement('style');
    style.textContent = `#operaNowcastCard .stats strong{font-size:12px;display:block;margin-top:2px}#operaNowcastCard .stats small{display:block;color:var(--muted);font-size:9px;margin-top:2px}@media(max-width:760px){#operaNowcastCard .stats{grid-template-columns:repeat(2,minmax(0,1fr))!important}}`;
    document.head.appendChild(style);
  }

  function setStatus(text) {
    ensureUi();
    const el = $('opStatus');
    if (el) el.textContent = text;
  }

  function apiUrl() {
    const end = new Date();
    end.setUTCSeconds(0, 0);
    const start = new Date(end.getTime() - FRAME_WINDOW_MIN * 60000);
    const dt = `${start.toISOString().slice(0,16)}Z/${end.toISOString().slice(0,16)}Z`;
    const q = new URLSearchParams({datetime:dt, f:'CoverageJSON', standard_name:'DBZH', format:'GeoTIFF', method:'comp'});
    return `${API}?${q}`;
  }

  function parseTime(value) {
    if (finite(Number(value)) && Number(value) > 1e9) {
      const n = Number(value);
      return n > 1e12 ? n : n * 1000;
    }
    const s = String(value || '');
    const iso = Date.parse(s);
    if (finite(iso)) return iso;
    const m = s.match(/(20\d{2})(\d{2})(\d{2})T(\d{2})(\d{2})(?:\d{2})?/);
    if (m) return Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5]);
    return NaN;
  }

  function extractFrames(payload) {
    const found = new Map();
    const seen = new Set();
    const walk = (node, inheritedTime = NaN) => {
      if (node == null) return;
      if (typeof node === 'string') {
        if (/^https?:\/\//i.test(node) && /(?:\.tif{1,2})(?:$|[?#])/i.test(node)) {
          const t = finite(inheritedTime) ? inheritedTime : parseTime(node);
          const key = node.split('#')[0];
          found.set(key, {url:key, time:t});
        }
        return;
      }
      if (typeof node !== 'object' || seen.has(node)) return;
      seen.add(node);
      let ownTime = inheritedTime;
      for (const k of ['datetime','date','time','timestamp','start_datetime','end_datetime','valid_time']) {
        if (k in node) {
          const t = parseTime(node[k]);
          if (finite(t)) { ownTime = t; break; }
        }
      }
      if (typeof node.href === 'string' && /\.tif{1,2}(?:$|[?#])/i.test(node.href)) {
        const t = finite(ownTime) ? ownTime : parseTime(node.href);
        const key = node.href.split('#')[0];
        found.set(key, {url:key, time:t});
      }
      for (const v of Object.values(node)) walk(v, ownTime);
    };
    walk(payload);
    return [...found.values()]
      .map(f => ({...f, time:finite(f.time) ? f.time : parseTime(f.url)}))
      .filter(f => finite(f.time))
      .sort((a,b) => a.time-b.time)
      .slice(-MAX_FRAMES);
  }

  function loadMetaCache() {
    try {
      const x = JSON.parse(localStorage.getItem(META_CACHE_KEY) || 'null');
      if (x && Date.now() - Number(x.savedAt) < META_CACHE_MS && Array.isArray(x.frames) && x.frames.length >= 3) return x.frames;
    } catch (_) {}
    return null;
  }

  function saveMetaCache(frames) {
    try { localStorage.setItem(META_CACHE_KEY, JSON.stringify({savedAt:Date.now(), frames})); } catch (_) {}
  }

  async function fetchFrames(force = false) {
    if (!force) {
      const cached = loadMetaCache();
      if (cached) return cached;
    }
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(), 12000);
    try {
      const r = await fetch(apiUrl(), {cache:'no-store', signal:c.signal, headers:{Accept:'application/json'}});
      if (r.status === 204) throw new Error('OPERA: brak danych w bieżącym oknie');
      if (!r.ok) throw new Error(`MeteoGate HTTP ${r.status}`);
      const payload = await r.json();
      const frames = extractFrames(payload);
      if (frames.length < 3) throw new Error('OPERA: API nie zwróciło co najmniej 3 GeoTIFF');
      saveMetaCache(frames);
      return frames;
    } finally { clearTimeout(timer); }
  }

  function projectedPoint(p) {
    const xy = window.proj4(PROJ_WGS84, PROJ_OPERA, [p.lon, p.lat]);
    if (!Array.isArray(xy) || !finite(xy[0]) || !finite(xy[1])) throw new Error('OPERA: błąd transformacji współrzędnych');
    return {x:xy[0], y:xy[1]};
  }

  function metadataNumber(meta, names, fallback) {
    if (!meta || typeof meta !== 'object') return fallback;
    const entries = Object.entries(meta);
    for (const name of names) {
      const hit = entries.find(([k]) => k.toLowerCase() === name.toLowerCase());
      if (hit) {
        const n = Number(hit[1]);
        if (finite(n)) return n;
      }
    }
    return fallback;
  }

  async function readFrame(frame, p) {
    const tiff = await window.GeoTIFF.fromUrl(frame.url, {cache:true});
    const image = await tiff.getImage();
    const w = image.getWidth(), h = image.getHeight();
    const bbox = image.getBoundingBox();
    if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error('OPERA: GeoTIFF bez georeferencji');
    const [minX,minY,maxX,maxY] = bbox;
    const pp = projectedPoint(p);
    const px = (pp.x - minX) / (maxX - minX) * w;
    const py = (maxY - pp.y) / (maxY - minY) * h;
    const scaleX = w / (maxX-minX), scaleY = h / (maxY-minY);
    const rx = GRID_RADIUS_KM * 1000 * scaleX, ry = GRID_RADIUS_KM * 1000 * scaleY;
    let x0 = Math.floor(px-rx), x1 = Math.ceil(px+rx), y0 = Math.floor(py-ry), y1 = Math.ceil(py+ry);
    x0=clamp(x0,0,w-2); x1=clamp(x1,x0+1,w); y0=clamp(y0,0,h-2); y1=clamp(y1,y0+1,h);

    const spp = Math.max(1, Number(image.getSamplesPerPixel?.() || 1));
    const samples = spp >= 2 ? [0,1] : [0];
    const rasters = await image.readRasters({window:[x0,y0,x1,y1], samples, width:GRID_N, height:GRID_N, resampleMethod:'nearest'});
    const raw = rasters[0];
    if (!raw || raw.length !== GRID_N*GRID_N) throw new Error('OPERA: niepoprawny raster DBZH');
    const qRaw = rasters[1] && rasters[1].length === raw.length ? rasters[1] : null;
    const meta = await image.getGDALMetadata?.(0).catch?.(() => null) || null;
    const datasetMeta = await image.getGDALMetadata?.(null).catch?.(() => null) || null;
    const gain = metadataNumber(meta, ['scale_factor','scale','gain'], metadataNumber(datasetMeta,['scale_factor','scale','gain'],1));
    const offset = metadataNumber(meta, ['add_offset','offset'], metadataNumber(datasetMeta,['add_offset','offset'],0));
    const nodata = typeof image.getGDALNoData === 'function' ? image.getGDALNoData() : null;

    let qUsable = false, qMean = NaN;
    if (qRaw) {
      let qn=0, qs=0, qmax=-Infinity, qmin=Infinity;
      for (const v of qRaw) if (finite(Number(v))) { const n=Number(v); qmin=Math.min(qmin,n);qmax=Math.max(qmax,n);qs+=n;qn++; }
      qUsable = qn > 50 && qmin >= 0 && qmax <= 1.05;
      qMean = qUsable ? qs/qn : NaN;
    }

    const values = new Float32Array(raw.length), mask = new Uint8Array(raw.length);
    let active=0, sum=0, max=-Infinity;
    const area = {ge35:0,ge40:0,ge45:0,ge50:0};
    for (let i=0;i<raw.length;i++) {
      const r = Number(raw[i]);
      if (!finite(r) || (nodata != null && r === Number(nodata))) { values[i]=NaN; continue; }
      const v = r*gain+offset;
      if (!finite(v) || v < -100 || v > 100) { values[i]=NaN; continue; }
      values[i]=v;
      max=Math.max(max,v);
      const qok = !qUsable || Number(qRaw[i]) >= QIND_MIN;
      if (v>=DBZ_THRESHOLD && qok) { mask[i]=1;active++;sum+=v; }
      if (qok && v>=35) area.ge35++;
      if (qok && v>=40) area.ge40++;
      if (qok && v>=45) area.ge45++;
      if (qok && v>=50) area.ge50++;
    }
    if (!finite(max)) max=NaN;
    return {time:frame.time, url:frame.url, values, mask, active, mean:active?sum/active:NaN, max, area, qMean, qUsable};
  }

  function scoreShift(a,b,sx,sy) {
    let inter=0, union=0, weighted=0;
    for (let y=SEARCH_SHIFT;y<GRID_N-SEARCH_SHIFT;y++) {
      const by=y+sy;if(by<0||by>=GRID_N)continue;
      for(let x=SEARCH_SHIFT;x<GRID_N-SEARCH_SHIFT;x++) {
        const bx=x+sx;if(bx<0||bx>=GRID_N)continue;
        const ia=y*GRID_N+x, ib=by*GRID_N+bx, ma=a.mask[ia], mb=b.mask[ib];
        if(!ma&&!mb)continue;
        union++;
        if(ma&&mb){inter++;const va=a.values[ia],vb=b.values[ib];weighted+=Math.min(va,vb)/Math.max(va,vb,1);}
      }
    }
    if(union<8)return -1;
    return .70*(inter/union)+.30*(inter?weighted/inter:0);
  }

  function estimatePair(a,b) {
    const dt=(b.time-a.time)/3600000;
    if(dt<=0||dt>.4||a.active<8||b.active<8)return null;
    let best=null;
    for(let sy=-SEARCH_SHIFT;sy<=SEARCH_SHIFT;sy++)for(let sx=-SEARCH_SHIFT;sx<=SEARCH_SHIFT;sx++){
      const score=scoreShift(a,b,sx,sy);if(score<0)continue;if(!best||score>best.score)best={sx,sy,score};
    }
    if(!best||best.score<.12)return null;
    const east=best.sx*GRID_STEP_KM/dt,north=-best.sy*GRID_STEP_KM/dt,speed=Math.hypot(east,north);
    if(speed>180)return null;
    return {...best,dt,east,north,speed,bearing:bearingFromVector(east,north)};
  }

  function vectorStats(grids) {
    const pairs=[];
    for(let i=0;i+2<grids.length;i++){const p=estimatePair(grids[i],grids[i+2]);if(p)pairs.push(p);}
    if(pairs.length<2)for(let i=0;i+1<grids.length;i++){const p=estimatePair(grids[i],grids[i+1]);if(p)pairs.push(p);}
    if(!pairs.length)return null;
    const good=pairs.slice(-6),east=median(good.map(x=>x.east)),north=median(good.map(x=>x.north)),speed=Math.hypot(east,north),bearing=bearingFromVector(east,north),score=median(good.map(x=>x.score));
    const spread=median(good.map(x=>Math.hypot(x.east-east,x.north-north)))||0;
    return {east,north,speed,bearing,score,consistency:clamp(1-spread/Math.max(25,speed),0,1),pairs:good};
  }

  function linearRate(grids, getter) {
    const rows=grids.map(g=>({t:g.time,y:Number(getter(g))})).filter(r=>finite(r.y));
    if(rows.length<3)return NaN;
    const t0=rows[0].t,x=rows.map(r=>(r.t-t0)/3600000),y=rows.map(r=>r.y),xm=x.reduce((a,b)=>a+b,0)/x.length,ym=y.reduce((a,b)=>a+b,0)/y.length;
    let num=0,den=0;for(let i=0;i<x.length;i++){num+=(x[i]-xm)*(y[i]-ym);den+=(x[i]-xm)**2;}
    return den?num/den:NaN;
  }

  function trendStats(grids) {
    const meanRate=linearRate(grids,g=>g.mean),maxRate=linearRate(grids,g=>g.max),area45Rate=linearRate(grids,g=>g.area.ge45);
    let label='stabilna';
    if((finite(maxRate)&&maxRate>=5)||(finite(area45Rate)&&area45Rate>=8))label='rozwój';
    else if((finite(maxRate)&&maxRate<=-5)||(finite(area45Rate)&&area45Rate<=-8))label='słabnie';
    return {label,meanDbzPerH:meanRate,maxDbzPerH:maxRate,area45CellsPerH:area45Rate};
  }

  function nearestEcho(latest) {
    let best=null;
    for(let gy=0;gy<GRID_N;gy++)for(let gx=0;gx<GRID_N;gx++){
      const i=gy*GRID_N+gx,v=latest.values[i];if(!finite(v)||v<DBZ_THRESHOLD||!latest.mask[i])continue;
      const east=(gx-CENTER)*GRID_STEP_KM,north=-(gy-CENTER)*GRID_STEP_KM,d=Math.hypot(east,north);
      if(!best||d<best.distance||(d===best.distance&&v>best.value))best={east,north,distance:d,value:v,bearing:bearingFromVector(east,north)};
    }
    return best;
  }

  function approachEcho(latest, vector) {
    if(!vector||vector.speed<4)return null;
    let best=null,vsq=vector.east**2+vector.north**2;
    for(let gy=0;gy<GRID_N;gy++)for(let gx=0;gx<GRID_N;gx++){
      const i=gy*GRID_N+gx,v=latest.values[i];if(!finite(v)||v<DBZ_THRESHOLD||!latest.mask[i])continue;
      const east=(gx-CENTER)*GRID_STEP_KM,north=-(gy-CENTER)*GRID_STEP_KM,t=-(east*vector.east+north*vector.north)/vsq;
      if(t<-.05||t>1.5)continue;
      const tt=Math.max(0,t),ce=east+vector.east*tt,cn=north+vector.north*tt,cpa=Math.hypot(ce,cn);
      if(cpa>30)continue;
      const c={east,north,value:v,tHours:tt,cpa,distance:Math.hypot(east,north),bearing:bearingFromVector(east,north)};
      if(!best||c.tHours<best.tHours-.05||(Math.abs(c.tHours-best.tHours)<.05&&c.cpa<best.cpa))best=c;
    }
    return best;
  }

  function gridSample(latest,east,north) {
    const gx=CENTER+east/GRID_STEP_KM,gy=CENTER-north/GRID_STEP_KM;
    if(gx<1||gy<1||gx>GRID_N-2||gy>GRID_N-2)return NaN;
    let best=NaN;
    for(let y=Math.floor(gy)-1;y<=Math.ceil(gy)+1;y++)for(let x=Math.floor(gx)-1;x<=Math.ceil(gx)+1;x++){
      const v=latest.values[y*GRID_N+x];if(finite(v)&&(!finite(best)||v>best))best=v;
    }
    return best;
  }

  function advect(latest, vector, trend) {
    const out={};
    for(const min of HORIZONS){const h=min/60,e=-vector.east*h,n=-vector.north*h;let v=gridSample(latest,e,n);if(finite(v)&&finite(trend?.meanDbzPerH))v=clamp(v+clamp(trend.meanDbzPerH,-12,12)*h*.5,-99,80);out[min]=v;}
    return out;
  }

  function confidence(grids,vector) {
    if(!vector)return 0;
    const newest=grids.at(-1)?.time||0,age=(Date.now()-newest)/60000,fresh=clamp(1-age/MAX_FRAME_AGE_MIN,0,1),frames=clamp(grids.length/8,0,1),quality=finite(grids.at(-1)?.qMean)?clamp(grids.at(-1).qMean,0,1):.65;
    return Math.round(100*(.44*clamp(vector.score,0,1)+.27*vector.consistency+.17*fresh+.08*frames+.04*quality));
  }

  function polradSignal(polrad) {
    if(!polrad||polrad.error)return false;
    if(polrad.source==='cmax'){
      const vals=Object.values(polrad.predictions||{}).map(Number).filter(finite);
      return vals.some(v=>v>=35)||Number(polrad.approach?.value)>=35||Number(polrad.nearest?.value)>=40;
    }
    return false;
  }

  function fuse(opera, polrad) {
    const pvec=polrad?.vector||null, ovec=opera?.vector||null;
    const dirDiff=pvec&&ovec?circularDiff(Number(pvec.bearingDeg),Number(ovec.bearingDeg)):NaN;
    const ps=Number(pvec?.speedKmh),os=Number(ovec?.speedKmh),speedDiff=finite(ps)&&finite(os)?Math.abs(ps-os):NaN;
    const vectorAgree=finite(dirDiff)&&finite(speedDiff)&&dirDiff<=45&&speedDiff<=Math.max(25,ps*.6);
    const pSignal=polradSignal(polrad),oStrong=Number(opera?.approach?.value)>=35||Number(opera?.nearest?.value)>=40||Object.values(opera?.predictions||{}).some(v=>Number(v)>=35);
    let convLevel='brak sygnału POLRAD';
    if(pSignal&&oStrong&&vectorAgree)convLevel='silne potwierdzenie';
    else if(pSignal&&oStrong)convLevel='częściowe potwierdzenie';
    else if(pSignal&&!oStrong)convLevel='brak potwierdzenia OPERA';
    const level=!pvec||!ovec?'brak porównania':vectorAgree?'zgodne':finite(dirDiff)&&dirDiff<=70?'częściowo zgodne':'rozbieżne';
    return {updatedAt:new Date().toISOString(),level,vectorAgree,dirDiffDeg:dirDiff,speedDiffKmh:speedDiff,convectiveSupport:convLevel,polradSignal:pSignal,operaSignal:oStrong,primary:'POLRAD',secondary:'OPERA CIRRUS'};
  }

  function publishOpera(result) {
    latestOpera=result;
    window.PrognozaEPIROperaNowcast=result;
    window.dispatchEvent(new CustomEvent('prognozaepir:opera-nowcast-updated',{detail:result}));
    publishFusion();
  }

  function publishFusion() {
    if(!latestOpera)return;
    const fusion=fuse(latestOpera,window.PrognozaEPIRRadarNowcast||null);
    window.PrognozaEPIRRadarFusion=fusion;
    window.dispatchEvent(new CustomEvent('prognozaepir:radar-fusion-updated',{detail:fusion}));
    renderFusion(fusion);
  }

  function renderFusion(f) {
    const a=$('opFusion'),b=$('opFusionSub'),c=$('opConv');
    if(a)a.textContent=f.level;
    if(b)b.textContent=finite(f.dirDiffDeg)?`Δ kier. ${Math.round(f.dirDiffDeg)}° · Δ V ${Math.round(f.speedDiffKmh)} km/h`:'wektor jednego źródła niedostępny';
    if(c)c.textContent=f.convectiveSupport;
  }

  function renderResult(r) {
    ensureUi();
    const latest=r.latest;
    $('opFrame').textContent=fmtUtcMs(latest.time);
    $('opFrames').textContent=`${r.frames} klatek · ${fmtUtcMs(r.frameStart)}–${fmtUtcMs(r.frameEnd)}`;
    $('opNearest').textContent=r.nearest?`${Math.round(r.nearest.distance)} km ${compass16(r.nearest.bearing)}`:'brak ≥27 dBZ';
    $('opNearestSub').textContent=r.nearest?dbzText(r.nearest.value):'w promieniu 160 km';
    $('opMax').textContent=dbzText(latest.max);
    $('opArea').textContent=`≥35: ${latest.area.ge35} · ≥40: ${latest.area.ge40} · ≥45: ${latest.area.ge45} · ≥50: ${latest.area.ge50} kom.`;
    $('opMotion').textContent=r.vector?`${compass16(r.vector.bearingDeg)} · ${Math.round(r.vector.speedKmh)} km/h`:'—';
    $('opMotionSub').textContent=r.vector?`${Math.round(r.vector.bearingDeg)}° · korelacja ${Math.round(r.vector.score*100)}/100`:'brak stabilnego wektora';
    $('opTrend').textContent=r.trend.label;
    $('opTrendSub').textContent=finite(r.trend.maxDbzPerH)?`max ${r.trend.maxDbzPerH>=0?'+':''}${r.trend.maxDbzPerH.toFixed(1)} dBZ/h`:'—';
    $('opQind').textContent=latest.qUsable?`${Math.round(latest.qMean*100)}/100`:'niedostępny';
    $('opQindSub').textContent=latest.qUsable?`piksele QIND < ${QIND_MIN.toFixed(2)} pomijane`:'DBZH analizowane bez dodatkowej maski QIND';
    $('opPred').textContent=HORIZONS.map(h=>`+${h}: ${dbzText(r.predictions[h])}`).join(' · ');
    const eta=r.approach?Math.round(r.approach.tHours*60):null;
    $('opSummary').textContent=r.approach
      ? `OPERA wskazuje echo z ${compass16(r.approach.bearing)} z możliwym zbliżeniem do ≤30 km od punktu za około ${eta} min. Trend: ${r.trend.label}. OPERA jest źródłem weryfikacyjnym; podstawą decyzji pozostaje POLRAD.`
      : `OPERA nie wskazuje obecnie trajektorii echa ≥27 dBZ przechodzącej w odległości ≤30 km od punktu w ciągu 90 min. Trend obszaru: ${r.trend.label}.`;
    setStatus(`aktualizacja ${fmtUtcMs(Date.now())} · ostatnia klatka ${fmtUtcMs(latest.time)} · EUMETNET OPERA DBZH`);
  }

  async function run(force=false) {
    ensureUi();
    if(running)return;
    if(!force&&Date.now()-lastRun<META_CACHE_MS)return;
    const p=currentPoint();if(!p){setStatus('OPERA: brak poprawnego punktu');return;}
    running=true;lastRun=Date.now();setStatus('OPERA: pobieranie metadanych GeoTIFF…');
    try {
      await ensureLibraries();
      const frames=await fetchFrames(force);
      const grids=[];
      for(let i=0;i<frames.length;i++){
        setStatus(`OPERA DBZH: klatka ${i+1}/${frames.length} · ${fmtUtcMs(frames[i].time)}`);
        try{grids.push(await readFrame(frames[i],p));}catch(e){console.warn('OPERA frame skipped',frames[i],e);}
      }
      if(grids.length<3)throw new Error('OPERA: nie udało się odczytać historii GeoTIFF');
      const useful=grids.filter((g,i)=>g.active>=2||i===grids.length-1);
      if(useful.length<3)throw new Error('OPERA: za mało użytecznych klatek');
      const latest=useful.at(-1),age=(Date.now()-latest.time)/60000;
      if(age>45)throw new Error(`OPERA: ostatnia klatka ma ${Math.round(age)} min`);
      const vector=vectorStats(useful),trend=trendStats(useful),nearest=nearestEcho(latest),approach=vector?approachEcho(latest,vector):null,predictions=vector?advect(latest,vector,trend):Object.fromEntries(HORIZONS.map(h=>[h,NaN])),conf=confidence(useful,vector);
      const result={updatedAt:new Date().toISOString(),point:p,source:'opera_cirrus_dbzh',frames:useful.length,frameStart:useful[0].time,frameEnd:latest.time,latest,vector:vector?{eastKmh:vector.east,northKmh:vector.north,speedKmh:vector.speed,bearingDeg:vector.bearing,score:vector.score,consistency:vector.consistency}:null,confidence:conf,trend,nearest,approach,etaMin:approach?approach.tHours*60:null,predictions,quality:{qindAvailable:latest.qUsable,qindMean:latest.qMean,qindThreshold:QIND_MIN}};
      renderResult(result);publishOpera(result);
    } catch(e) {
      console.error('OPERA Nowcast:',e);
      const msg=String(e?.message||e);
      setStatus(`OPERA: ${msg}`);
      $('opSummary').textContent=`OPERA chwilowo niedostępna (${msg}). POLRAD działa niezależnie i pozostaje źródłem podstawowym.`;
      publishOpera({updatedAt:new Date().toISOString(),point:p,error:msg,source:'opera_cirrus_dbzh'});
    } finally {running=false;}
  }

  ensureUi();
  window.addEventListener('prognozaepir:radar-nowcast-updated',publishFusion);
  for(const id of ['apply','resetPoint','refresh'])$(id)?.addEventListener('click',()=>setTimeout(()=>run(true),800));
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&Date.now()-lastRun>AUTO_MS)run(false);});
  setTimeout(()=>run(false),2600);
  setInterval(()=>{if(!document.hidden)run(false);},AUTO_MS);
  window.PrognozaEPIROperaNowcastEngine={refresh:()=>run(true),get:()=>window.PrognozaEPIROperaNowcast||null,getFusion:()=>window.PrognozaEPIRRadarFusion||null};
})();