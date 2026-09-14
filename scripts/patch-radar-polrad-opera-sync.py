from pathlib import Path
import re


def replace_once(text, old, new, label):
    if old in text:
        return text.replace(old, new, 1)
    if new in text:
        return text
    raise SystemExit(f"missing anchor: {label}")


def sub_once(text, pattern, repl, label):
    out, n = re.subn(pattern, repl, text, count=1, flags=re.S)
    if n == 1:
        return out
    raise SystemExit(f"missing regex anchor: {label}")


# ---------------------------------------------------------------------------
# Official POLRAD map: one physical overlay for animation + complete product UI
p = Path("radar-intelligence.js")
s = p.read_text(encoding="utf-8")
s = s.replace("// PrognozaEPIR v0.11.0", "// PrognozaEPIR v0.11.2", 1)
s = s.replace("version.textContent = 'RADAR / SAT / AI v0.11.0'", "version.textContent = 'RADAR / SAT / AI v0.11.2'", 1)

s = replace_once(s, """  const POLRAD_PRODUCTS = {
    cmax: {label:'POLRAD CMAX', short:'CMAX'},
    sri:  {label:'POLRAD SRI', short:'SRI'},
    pac:  {label:'POLRAD PAC 1h', short:'PAC'}
  };
""", """  // Six visualisations exposed by the official IMGW radar viewer.
  // API aliases are probed at runtime. If IMGW does not expose a list endpoint
  // for a product, its button is disabled instead of showing a different field.
  const POLRAD_PRODUCTS = {
    cmax:  {label:'POLRAD CMAX', short:'CMAX', apiKeys:['cmax'], operaComparable:true},
    cappi: {label:'POLRAD CAPPI 1 km', short:'CAPPI', apiKeys:['cappi','cappi1','cappi_1km'], operaComparable:true},
    eht:   {label:'POLRAD EHT', short:'EHT', apiKeys:['eht','etop','echo_top'], operaComparable:false},
    sri:   {label:'POLRAD SRI', short:'SRI', apiKeys:['sri'], operaComparable:false},
    pac:   {label:'POLRAD PAC 1 h', short:'PAC', apiKeys:['pac'], operaComparable:false},
    hail:  {label:'POLRAD grad', short:'GRAD', apiKeys:['hail','hails','hailprob','hail_prob','grad'], operaComparable:false}
  };
""", "POLRAD product catalogue")

s = replace_once(s, """  let polradLayer = null;
  let polradTimer = null;
  let polradAvailable = false;
""", """  let polradLayer = null;
  let polradTimer = null;
  let polradAvailable = false;
  let polradFrameToken = 0;
  const polradFrameCache = new Map();
  const POLRAD_PANE = 'polradImagePane';
""", "POLRAD state")

s = s.replace("przyciskami CMAX/SRI/PAC.", "przyciskami produktów POLRAD.")

s = sub_once(s,
    r"  async function fetchPolradFrames\(product\) \{.*?\n  \}\n\n  function removePolradLayer\(\) \{.*?\n  \}\n\n  function setPolradFrame\(index\) \{.*?\n  \}\n\n  async function selectPolrad",
    r"""  async function fetchPolradFrames(product, {force=false}={}) {
    if (!force && polradFrameCache.has(product)) return polradFrameCache.get(product).frames;
    const meta = POLRAD_PRODUCTS[product] || {apiKeys:[product]};
    let lastError = null;
    for (const apiKey of (meta.apiKeys || [product])) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 9000);
      try {
        const r = await fetch(`https://meteo.imgw.pl/api/radars/v1/list/${encodeURIComponent(apiKey)}`, {
          cache:'no-cache', signal:controller.signal
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const data = await r.json();
        const direct = data?.[apiKey]?.list || data?.[product]?.list;
        const fallback = direct || Object.values(data || {}).find(v => Array.isArray(v?.list))?.list;
        if (!Array.isArray(fallback) || !fallback.length) throw new Error('brak klatek');
        const frames = fallback
          .filter(f => f && f.url && Number.isFinite(Number(f.date)))
          .sort((a, b) => Number(a.date) - Number(b.date));
        if (!frames.length) throw new Error('brak poprawnych klatek');
        polradFrameCache.set(product,{frames,apiKey,checkedAt:Date.now()});
        meta.resolvedApiKey = apiKey;
        return frames;
      } catch (e) {
        lastError = e;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError || new Error('produkt niedostępny w API listy');
  }

  async function auditPolradProducts() {
    await Promise.all(Object.keys(POLRAD_PRODUCTS).map(async product => {
      const b = polradButtons[product];
      if (!b) return;
      try {
        const frames = await fetchPolradFrames(product);
        b.disabled = false;
        b.dataset.available = '1';
        const key = POLRAD_PRODUCTS[product].resolvedApiKey || product;
        b.title = `${POLRAD_PRODUCTS[product].short}: ${frames.length} klatek · IMGW / ${key}`;
      } catch (_) {
        b.dataset.available = '0';
        b.disabled = product !== 'cmax';
        b.title = `${POLRAD_PRODUCTS[product].short}: oficjalny produkt IMGW, ale brak działającego endpointu listy obrazów`;
      }
    }));
  }

  function ensurePolradPane() {
    let pane = map.getPane(POLRAD_PANE);
    if (!pane) pane = map.createPane(POLRAD_PANE);
    pane.style.zIndex = '470';
    pane.style.pointerEvents = 'none';
    return pane;
  }

  function removePolradLayer() {
    try {
      map.eachLayer(layer => {
        if (!L.ImageOverlay || !(layer instanceof L.ImageOverlay)) return;
        if (layer === polradLayer || layer?.options?.attribution === 'IMGW-PIB / POLRAD') {
          if (map.hasLayer(layer)) map.removeLayer(layer);
        }
      });
    } catch (_) {}
    polradLayer = null;
  }

  function preloadPolradFrame(index) {
    if (!polradFrames.length) return;
    const i = clamp01(Math.round(Number(index) || 0), 0, polradFrames.length - 1);
    const frame = polradFrames[i];
    if (!frame?.url) return;
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = normalizeImgwUrl(frame.url);
    } catch (_) {}
  }

  function publishPolradFrame(frame) {
    const meta = POLRAD_PRODUCTS[polradProduct] || {};
    const detail = {
      product:polradProduct,
      short:meta.short || polradProduct,
      timeSec:Number(frame.date),
      timeMs:Number(frame.date) * 1000,
      comparableToOpera:!!meta.operaComparable,
      index:polradIndex,
      count:polradFrames.length,
      url:normalizeImgwUrl(frame.url)
    };
    window.PrognozaEPIRPolradState = detail;
    window.dispatchEvent(new CustomEvent('prognozaepir:polrad-frame-changed',{detail}));
  }

  function setPolradFrame(index) {
    if (!polradFrames.length) return;
    polradIndex = clamp01(Math.round(Number(index) || 0), 0, polradFrames.length - 1);
    if (historyRange) historyRange.value = polradIndex;
    const frame = polradFrames[polradIndex];
    const url = normalizeImgwUrl(frame.url);
    const active = !!polradButtons[polradProduct]?.classList.contains('active');
    const token = ++polradFrameToken;
    ensurePolradPane();

    const onLoad = () => {
      if (token !== polradFrameToken || !polradLayer) return;
      if (active && map.hasLayer(polradLayer)) polradLayer.setOpacity(.70);
      preloadPolradFrame(polradIndex + 1 < polradFrames.length ? polradIndex + 1 : Math.max(0,polradFrames.length - 18));
    };
    const onError = () => {
      if (token !== polradFrameToken) return;
      if (polradLayer) polradLayer.setOpacity(0);
      setPolradStatus('POLRAD: błąd tej klatki — poprzedni obraz nie jest pozostawiany jako zamrożone tło.');
    };

    if (!polradLayer) {
      polradLayer = L.imageOverlay(url, POLRAD_BOUNDS, {
        pane:POLRAD_PANE, opacity:0, interactive:false, crossOrigin:true,
        attribution:'IMGW-PIB / POLRAD'
      });
      polradLayer.once('load', onLoad);
      polradLayer.once('error', onError);
      if (active) polradLayer.addTo(map);
    } else {
      polradLayer.setOpacity(0);
      polradLayer.setBounds(POLRAD_BOUNDS);
      polradLayer.once('load', onLoad);
      polradLayer.once('error', onError);
      polradLayer.setUrl(url);
      if (active && !map.hasLayer(polradLayer)) polradLayer.addTo(map);
    }

    const timeEl = byId('radarTime');
    if (timeEl) timeEl.textContent = `${POLRAD_PRODUCTS[polradProduct]?.short || polradProduct}: ${fmtRadarTime(frame.date)} UTC`;
    setPolradStatus(`Mapa: IMGW/POLRAD ${POLRAD_PRODUCTS[polradProduct]?.short || polradProduct} · ${fmtRadarTime(frame.date)} UTC · jedna aktywna klatka.`);
    publishPolradFrame(frame);
  }

  async function selectPolrad""",
    "POLRAD fetch/layer/frame")

s = s.replace("polradFrames = await fetchPolradFrames(product);", "polradFrames = await fetchPolradFrames(product,{force:true});", 1)

s = sub_once(s,
    r"  function togglePolradAnimation\(\) \{.*?\n  \}\n\n  // ---------- Official IMGW warning overlay",
    r"""  function togglePolradAnimation() {
    if (polradTimer) { stopPolradAnimation(); return; }
    if (!polradAvailable || !polradFrames.length) return;
    if (playButton) playButton.textContent = '■ Stop';
    const start = Math.max(0, polradFrames.length - 18);
    let i = start;
    // Draw immediately, then reuse the SAME ImageOverlay via setUrl().
    setPolradFrame(i);
    i = i + 1 < polradFrames.length ? i + 1 : start;
    preloadPolradFrame(i);
    polradTimer = setInterval(() => {
      setPolradFrame(i);
      i++;
      if (i >= polradFrames.length) i = start;
      preloadPolradFrame(i);
    }, 700);
  }

  // ---------- Official IMGW warning overlay""",
    "POLRAD animation")

s = replace_once(s, """  selectPolrad('cmax').catch(() => {});
  scheduleEnhanced(1400);
""", """  selectPolrad('cmax').catch(() => {});
  setTimeout(() => auditPolradProducts().catch(() => {}), 700);
  scheduleEnhanced(1400);
""", "POLRAD initial audit")

p.write_text(s, encoding="utf-8")


# ---------------------------------------------------------------------------
# OPERA: synchronize the visible CMAX frame to the selected POLRAD UTC frame.
p = Path("opera-nowcast.js")
s = p.read_text(encoding="utf-8")
s = replace_once(s, "  const QIND_MIN = 0.25;\n", "  const QIND_MIN = 0.25;\n  const SYNC_TOLERANCE_MIN = 7.5;\n", "OPERA sync constant")
s = replace_once(s,
    "  let running=false,lastRun=0,latestOpera=null,libPromise=null,operaLayer=null,mapEnabled=false,mapButton=null;\n",
    "  let running=false,lastRun=0,latestOpera=null,libPromise=null,operaLayer=null,mapEnabled=false,mapButton=null;\n  let operaFrameHistory=[];\n  let lastPolradFrame=null;\n",
    "OPERA state")

s = replace_once(s, "  const pad2=n=>String(n).padStart(2,'0');\n\n", """  const pad2=n=>String(n).padStart(2,'0');
  const normalizeMs=value=>{const n=Number(value);return finite(n)?(n<1e12?n*1000:n):NaN};
  const polradFrameMs=p=>normalizeMs(p?.timeMs ?? p?.frameEnd ?? p?.timeSec);

""", "OPERA time helpers")

s = s.replace("if(latestOpera?.latest&&!latestOpera.error)renderMapLayer(latestOpera.latest);else await run(true);", "if(latestOpera?.latest&&!latestOpera.error)renderSynchronizedMap();else await run(true);", 1)

s = sub_once(s,
    r"  function fuse\(opera,polrad\)\{.*?\n  \}\n\n  function colorForDbz",
    r"""  function fuse(opera,polrad){
    const pvec=polrad?.vector||null,ovec=opera?.vector||null;
    const pTime=normalizeMs(polrad?.frameEnd),oTime=normalizeMs(opera?.frameEnd ?? opera?.latest?.time);
    const frameSkewMin=finite(pTime)&&finite(oTime)?Math.abs(oTime-pTime)/60000:NaN;
    const timeAligned=finite(frameSkewMin)&&frameSkewMin<=SYNC_TOLERANCE_MIN;
    const dirDiff=pvec&&ovec?circularDiff(Number(pvec.bearingDeg),Number(ovec.bearingDeg)):NaN,ps=Number(pvec?.speedKmh),os=Number(ovec?.speedKmh),speedDiff=finite(ps)&&finite(os)?Math.abs(ps-os):NaN;
    const vectorAgree=timeAligned&&finite(dirDiff)&&finite(speedDiff)&&dirDiff<=45&&speedDiff<=Math.max(25,ps*.6),pSignal=polradSignal(polrad),oStrong=Number(opera?.approach?.value)>=35||Number(opera?.nearest?.value)>=40||Object.values(opera?.predictions||{}).some(v=>Number(v)>=35);
    let convLevel='brak sygnału do potwierdzenia';
    if(!timeAligned)convLevel='brak porównania — różny czas';
    else if(pSignal&&oStrong&&vectorAgree)convLevel='potwierdza';
    else if(pSignal&&oStrong)convLevel='częściowo potwierdza';
    else if(pSignal&&!oStrong)convLevel='nie potwierdza';
    const level=!timeAligned?'czasowo rozbieżne':!pvec||!ovec?'brak porównania':vectorAgree?'zgodne':finite(dirDiff)&&dirDiff<=70?'częściowo zgodne':'rozbieżne';
    return{updatedAt:new Date().toISOString(),level,vectorAgree,dirDiffDeg:dirDiff,speedDiffKmh:speedDiff,convectiveSupport:convLevel,polradSignal:pSignal,operaSignal:oStrong,primary:'POLRAD',secondary:'OPERA CIRRUS',timeAligned,frameSkewMin:finite(frameSkewMin)?frameSkewMin:null,syncToleranceMin:SYNC_TOLERANCE_MIN};
  }

  function colorForDbz""",
    "OPERA fusion")

s = sub_once(s,
    r"  function renderMapLayer\(latest\)\{.*?\n\n  function publishOpera",
    r"""  function renderMapLayer(latest){
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

  function hideOperaLayer(){try{if(operaLayer&&typeof map!=='undefined'&&map.hasLayer(operaLayer))map.removeLayer(operaLayer)}catch(_){}}

  function closestOperaFrame(targetMs){
    if(!finite(targetMs)||!operaFrameHistory.length)return null;
    let best=null,bestDiff=Infinity;
    for(const frame of operaFrameHistory){const t=normalizeMs(frame?.time),d=Math.abs(t-targetMs);if(finite(t)&&d<bestDiff){best=frame;bestDiff=d}}
    return best?{frame:best,skewMin:bestDiff/60000}:null;
  }

  function renderSynchronizedMap(polrad=lastPolradFrame||window.PrognozaEPIRPolradState||null){
    lastPolradFrame=polrad||lastPolradFrame;
    if(!mapEnabled)return;
    if(!polrad){
      if(latestOpera?.latest)renderMapLayer(latestOpera.latest);
      return;
    }
    if(!polrad.comparableToOpera){
      hideOperaLayer();
      if(mapButton)mapButton.title=`OPERA CMAX: brak bezpośredniego porównania z produktem ${String(polrad.short||polrad.product||'POLRAD')}`;
      setStatus(`OPERA ukryta: ${String(polrad.short||polrad.product||'wybrany produkt POLRAD')} nie jest polem odbiciowości porównywalnym 1:1 z OPERA CMAX.`);
      return;
    }
    const target=polradFrameMs(polrad),match=closestOperaFrame(target);
    if(!match||match.skewMin>SYNC_TOLERANCE_MIN){
      hideOperaLayer();
      const d=match?`Δt ${match.skewMin.toFixed(1)} min`:'brak wspólnej klatki';
      if(mapButton)mapButton.title=`OPERA ukryta: ${d}; tolerancja ${SYNC_TOLERANCE_MIN} min`;
      setStatus(`OPERA: ${d} względem ${String(polrad.short||polrad.product||'POLRAD')} — warstwa ukryta, aby nie pokazywać przesuniętego czasu.`);
      return;
    }
    renderMapLayer(match.frame);
    if(mapButton)mapButton.title=`OPERA zsynchronizowana z ${String(polrad.short||polrad.product||'POLRAD')} · Δt ${match.skewMin.toFixed(1)} min`;
    setStatus(`OPERA ${fmtUtcMs(match.frame.time)} · synchronizacja z ${String(polrad.short||polrad.product||'POLRAD')} · Δt ${match.skewMin.toFixed(1)} min UTC.`);
  }

  function publishOpera""",
    "OPERA synchronized map")

s = s.replace("function renderFusion(f){if($('opFusion'))$('opFusion').textContent=f.level;if($('opConv'))$('opConv').textContent=f.convectiveSupport;if($('opFusionSub'))$('opFusionSub').textContent=finite(f.dirDiffDeg)?`różnica kierunku ${Math.round(f.dirDiffDeg)}° · prędkości ${Math.round(f.speedDiffKmh)} km/h`:'wektor jednego źródła niedostępny'}",
              "function renderFusion(f){if($('opFusion'))$('opFusion').textContent=f.level;if($('opConv'))$('opConv').textContent=f.convectiveSupport;if($('opFusionSub'))$('opFusionSub').textContent=f.frameSkewMin!=null?`Δt POLRAD–OPERA ${f.frameSkewMin.toFixed(1)} min · ${finite(f.dirDiffDeg)?'kierunek '+Math.round(f.dirDiffDeg)+'°':'brak wspólnego wektora'}`:(finite(f.dirDiffDeg)?`różnica kierunku ${Math.round(f.dirDiffDeg)}° · prędkości ${Math.round(f.speedDiffKmh)} km/h`:'wektor jednego źródła niedostępny')}", 1)

s = s.replace(";renderMapLayer(latest);\n  }", ";renderSynchronizedMap();\n  }", 1)
s = s.replace("try{latest.display=await readDisplayRaster(latest,p)}catch(e){console.warn('OPERA 1 km display raster unavailable; using 4 km fallback',e)}\n      const vector=", "try{latest.display=await readDisplayRaster(latest,p)}catch(e){console.warn('OPERA 1 km display raster unavailable; using 4 km fallback',e)}\n      operaFrameHistory=grids.slice();\n      const vector=", 1)

s = replace_once(s,
    "  ensureUi();window.addEventListener('prognozaepir:radar-nowcast-updated',publishFusion);for(const id of ['apply','resetPoint','refresh'])$(id)?.addEventListener('click',()=>setTimeout(()=>run(true),650));document.addEventListener('visibilitychange',()=>{if(!document.hidden&&Date.now()-lastRun>AUTO_MS)run(false)});setTimeout(()=>run(false),1200);setInterval(()=>{if(!document.hidden)run(false)},AUTO_MS);\n  window.PrognozaEPIROperaNowcastEngine={refresh:()=>run(true),get:()=>window.PrognozaEPIROperaNowcast||null,getFusion:()=>window.PrognozaEPIRRadarFusion||null,toggleMap:()=>mapButton?.click()};\n",
    "  ensureUi();window.addEventListener('prognozaepir:radar-nowcast-updated',publishFusion);window.addEventListener('prognozaepir:polrad-frame-changed',ev=>{lastPolradFrame=ev?.detail||null;renderSynchronizedMap(lastPolradFrame)});for(const id of ['apply','resetPoint','refresh'])$(id)?.addEventListener('click',()=>setTimeout(()=>run(true),650));document.addEventListener('visibilitychange',()=>{if(!document.hidden&&Date.now()-lastRun>AUTO_MS)run(false)});setTimeout(()=>run(false),1200);setInterval(()=>{if(!document.hidden)run(false)},AUTO_MS);\n  window.PrognozaEPIROperaNowcastEngine={refresh:()=>run(true),get:()=>window.PrognozaEPIROperaNowcast||null,getFusion:()=>window.PrognozaEPIRRadarFusion||null,toggleMap:()=>mapButton?.click(),syncToPolrad:p=>renderSynchronizedMap(p||window.PrognozaEPIRPolradState||null)};\n",
    "OPERA event wiring")

p.write_text(s, encoding="utf-8")


# ---------------------------------------------------------------------------
# Activate the maintained POLRAD/OPERA modules on the actual radar page.
p = Path("radar.html")
s = p.read_text(encoding="utf-8")
tags = """<script src="radar-intelligence.js?v=20260914-radar-sync-v3"></script>
<script src="opera-nowcast.js?v=20260914-radar-sync-v3"></script>
"""
if "radar-intelligence.js?v=20260914-radar-sync-v3" not in s:
    if "</body>" not in s:
        raise SystemExit("radar.html missing </body>")
    s = s.replace("</body>", tags + "</body>", 1)
p.write_text(s, encoding="utf-8")

print("POLRAD/OPERA patch applied")
