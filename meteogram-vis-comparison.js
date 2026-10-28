'use strict';
(() => {
  if (typeof window === 'undefined' || typeof document === 'undefined' ||
      window.__EPIR_METEOGRAM_VIS_COMPARISON__) return;
  const cv = document.getElementById('meteo');
  if (!cv) return;
  window.__EPIR_METEOGRAM_VIS_COMPARISON__ = true;
  const finite = Number.isFinite, KM_MAX = 15, HOUR = 3600e3;
  const NWP_COLOR = '#2d91d0', OBS_COLOR = '#9c39c8';
  let observations = [], lastFetched = 0, request = null;

  function normalize(data) {
    const rows = [...(data?.metar_only || data?.metar || []), ...(data?.speci || [])];
    const byTime = new Map();
    for (const r of rows) {
      if (String(r?.station || r?.station_code || 'EPIR').toUpperCase() !== 'EPIR') continue;
      const t = Date.parse(r?.obs_time || r?.observed_at || r?.message_time || '');
      const vis = Number(r?.visibility_m);
      if (!finite(t) || !finite(vis) || vis <= 0) continue;
      const raw = String(r?.raw || r?.canonical_raw || '').toUpperCase();
      const bounded = Boolean(r?.visibility_lower_bound) ||
        /(?:^|\s)(9999|CAVOK)(?=\s|=|$)/.test(raw);
      const kind = String(r?.type || r?.report_type || 'METAR').toUpperCase();
      // Prefer SPECI at equal timestamps; it may document a rapid change.
      if (!byTime.has(t) || kind === 'SPECI')
        byTime.set(t, {t, vis, bounded, kind, raw});
    }
    return [...byTime.values()].sort((a,b) => a.t-b.t);
  }

  async function refresh(force = false) {
    if (request || (!force && Date.now()-lastFetched < 5*60e3)) return request;
    request = (async () => {
      try {
        const archive = window.PrognozaEPIRMessageArchive;
        let recent;
        if (archive && typeof archive.recent === 'function') {
          recent = await archive.recent(true);
        } else {
          const r = await fetch('data/messages/recent.json?_=' + Date.now(), {cache:'no-store'});
          if (!r.ok) throw new Error('METAR HTTP ' + r.status);
          recent = await r.json();
        }
        const rows = normalize(recent);
        if (rows.length) observations = rows;
        lastFetched = Date.now();
        if (typeof draw === 'function') draw();
      } catch (e) {
        console.warn('METAR visibility overlay:', e);
      }
    })();
    try { return await request; } finally { request = null; }
  }

  function paint() {
    const m = cv._meta, context = cv.getContext('2d');
    if (!m || !context || !Array.isArray(m.data) || !m.data.length ||
        !finite(m.t0) || !finite(m.t1) || m.t1<=m.t0) return;
    const panel = (m.panelYs || []).find(x => x?.id === 'visfog');
    if (!panel || panel.h <= 0) return;
    const pad = Math.min(9, Math.max(7, panel.h * .09));
    const x = t => m.x0 + (t-m.t0)/(m.t1-m.t0)*(m.x1-m.x0);
    const y = v => panel.y+panel.h-pad -
      Math.max(0,Math.min(KM_MAX,v/1000))/KM_MAX*(panel.h-2*pad);
    const hasNwp = m.data.some(r => finite(Number(r?.VIS_MODEL)) && Number(r?.VIS_MODEL) > 0);
    context.save();
    context.beginPath();
    context.rect(m.x0,panel.y,m.x1-m.x0,panel.h);
    context.clip();
    if (hasNwp) {
      context.strokeStyle = NWP_COLOR;
      context.lineWidth = 1.75;
      context.setLineDash([5,4]);
      context.beginPath();
      let started = false;
      for (const row of m.data) {
        const v = Number(row?.VIS_MODEL), t=Number(row?.t);
        if (!finite(v) || v<=0 || !finite(t)) {started=false;continue;}
        if (!started) context.moveTo(x(t),y(v));
        else context.lineTo(x(t),y(v));
        started=true;
      }
      context.stroke();
      context.setLineDash([]);
    }
    for (const o of observations) {
      if (o.t<m.t0 || o.t>m.t1 || o.t>Date.now()+10*60000) continue;
      const xx=x(o.t), yy=y(o.vis);
      context.strokeStyle=OBS_COLOR;context.fillStyle=OBS_COLOR;context.lineWidth=1.5;
      if (o.bounded) {
        // 9999/CAVOK is a lower bound, not an exact 10-km observation.
        context.beginPath();context.moveTo(xx,yy-5);context.lineTo(xx-4.7,yy+4);
        context.lineTo(xx+4.7,yy+4);context.closePath();context.stroke();
      } else {
        context.beginPath();context.arc(xx,yy,3.5,0,2*Math.PI);context.fill();
        context.strokeStyle='#fff';context.lineWidth=.8;context.stroke();
      }
    }
    context.restore();
    updateLegend(hasNwp);
  }

  function updateLegend(hasNwp) {
    const legend=document.querySelector('.legend');
    if (!legend) return;
    let node=document.getElementById('epirVisComparisonLegend');
    if (!node) {
      node=document.createElement('div');
      node.id='epirVisComparisonLegend';
      node.style.cssText='font-size:10px;line-height:1.5;margin-top:5px;padding-top:5px;border-top:1px solid var(--border)';
      legend.appendChild(node);
    }
    const recent=observations.filter(x=>x.t<=Date.now()+10*60000).at(-1);
    const obsText=recent ? (recent.bounded?'≥':'')+(recent.vis/1000).toFixed(recent.vis<10000?1:0)+
      ' km ('+new Date(recent.t).toISOString().slice(11,16)+' UTC, '+recent.kind+')' : 'brak';
    const text='Niebieska przerywana: VIS konsensusu NWP'+(hasNwp?'':' (brak danych)')+
      ' · Fioletowe punkty: METAR/SPECI (trójkąt = ≥10 km)'+
      ' · Ostatni pomiar: '+obsText;
    if (node.textContent !== text) node.textContent=text;
  }

  if (typeof draw==='function') {
    const previousDraw=draw;
    draw=function() {
      const out=previousDraw.apply(this,arguments);
      paint();
      return out;
    };
  }
  window.PrognozaEPIRMeteogramVisComparison=Object.freeze({
    normalize, getObservations:()=>observations.slice(), refresh
  });
  refresh(true);
  setInterval(()=>{if(document.visibilityState!=='hidden') refresh(true)},5*60e3);
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState!=='hidden') refresh();
  });
})();
