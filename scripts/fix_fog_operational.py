from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly one match, got {count}")
    return text.replace(old, new, 1)


p = Path("fog-engine.js")
s = p.read_text(encoding="utf-8")

s = replace_once(
    s,
    "const APP_VERSION = 'v0.10.23 HTML';",
    "const APP_VERSION = 'v0.10.24 HTML';",
    "fog app version",
)
s = replace_once(
    s,
    "const ENGINE_VERSION = 'EPIR FOG ENGINE v1.2';",
    "const ENGINE_VERSION = 'EPIR FOG ENGINE v1.3';",
    "fog engine version",
)

s = replace_once(
    s,
    """  function scoreClass(s){
    if(!finite(s))return 'brak danych';
    if(s>=90)return 'skrajnie wysokie';
    if(s>=75)return 'bardzo wysokie';
    if(s>=60)return 'wysokie';
    if(s>=40)return 'umiarkowane';
    if(s>=20)return 'małe';
    return 'bardzo małe';
  }""",
    """  function scoreClass(s){
    if(!finite(s))return 'BRAK DANYCH';
    if(s<40)return 'NIE';
    if(s<60)return 'MOŻLIWA';
    if(s<80)return 'PRAWDOPODOBNA';
    return 'BARDZO PRAWDOPODOBNA';
  }""",
    "operational fog labels",
)

s = replace_once(
    s,
    """  function riskCss(s){
    return s>=75?'fog-risk-vhigh':s>=60?'fog-risk-high':s>=40?'fog-risk-mid':'fog-risk-low';
  }""",
    """  function riskCss(s){
    if(!finite(s)||s<40)return '';
    return s>=80?'fog-risk-vhigh':s>=60?'fog-risk-high':'fog-risk-mid';
  }""",
    "operational fog colors",
)

s = replace_once(
    s,
    """      <div class="fog-thresholds"><b>Skala ryzyka v1.1:</b> 0–19 bardzo małe · 20–39 małe · 40–59 umiarkowane · 60–74 wysokie · 75–89 bardzo wysokie · 90–100 skrajnie wysokie. <b>Wynik /100 jest score ryzyka, nie skalibrowanym procentem P(FG).</b></div>""",
    """      <div class="fog-thresholds"><b>Interpretacja operacyjna:</b> &lt;40 = MGŁA: NIE (wynik pomijany) · 40–59 = MOŻLIWA · 60–79 = PRAWDOPODOBNA · 80–100 = BARDZO PRAWDOPODOBNA. <b>Kolor i komunikat wynikają wyłącznie z końcowego EPIR score.</b> Wynik /100 jest score ryzyka, nie skalibrowanym procentem P(FG).</div>""",
    "fog threshold legend",
)

s = replace_once(
    s,
    """  function onsetAndDissipation(series){
    let onset=null;
    for(let i=0;i<series.length;i++){
      const s=series[i];
      if(s.score>=65 && series[i+1]?.score>=65){onset=s.t;break;}
      if(s.score>=80 && s.obsUsed){onset=s.t;break;}
    }
    let end=null;
    if(onset){
      const idx=series.findIndex(x=>x.t>=onset);
      for(let i=idx+1;i<series.length-1;i++){
        if(series[i].score<40&&series[i+1].score<40){end=series[i].t;break;}
      }
    }
    const peak=series.reduce((a,b)=>!a||b.score>a.score?b:a,null);
    let peakFrom=null,peakTo=null;
    if(peak){
      const thr=.85*peak.score,pi=series.indexOf(peak);let a=pi,b=pi;
      while(a>0&&series[a-1].score>=thr)a--;
      while(b<series.length-1&&series[b+1].score>=thr)b++;
      peakFrom=series[a].t;peakTo=series[b].t;
    }
    return {onset,end,peak,peakFrom,peakTo};
  }""",
    """  function onsetAndDissipation(series){
    const idx=series.findIndex(x=>finite(x?.score)&&x.score>=40);
    const onset=idx>=0?series[idx].t:null;
    let end=null;
    if(idx>=0){
      let last=idx;
      while(last+1<series.length&&finite(series[last+1]?.score)&&series[last+1].score>=40)last++;
      end=series[last+1]?.t??null;
    }
    const peak=series.reduce((a,b)=>!a||b.score>a.score?b:a,null);
    let peakFrom=null,peakTo=null;
    if(peak&&peak.score>=40){
      const thr=Math.max(40,.85*peak.score),pi=series.indexOf(peak);let a=pi,b=pi;
      while(a>0&&series[a-1].score>=thr)a--;
      while(b<series.length-1&&series[b+1].score>=thr)b++;
      peakFrom=series[a].t;peakTo=series[b].t;
    }
    return {onset,end,peak,peakFrom,peakTo};
  }""",
    "fog onset window",
)

s = replace_once(
    s,
    "    fogSeries=out;renderFog();",
    "    fogSeries=out;window.PrognozaEPIRFogSeries=fogSeries;renderFog();window.dispatchEvent(new CustomEvent('prognozaepir:fog-series-updated'));",
    "fog series publication",
)

s = replace_once(
    s,
    """      <div class="fog-card ${riskCss(current.score)}"><small>MGŁA — EPIR score</small><strong>${fmt0(current.score)}/100</strong><em>${scoreClass(current.score)}</em></div>""",
    """      <div class="fog-card ${riskCss(current.score)}"><small>MGŁA — OPERACYJNIE</small><strong>${scoreClass(current.score)}</strong><em>${current.score>=40?fmt0(current.score)+'/100':'wynik <40/100 pominięty'}</em></div>""",
    "current fog summary",
)

s = replace_once(
    s,
    """      <div class="fog-card"><small>Początek / zanik</small><strong>${ev.onset?localHour(ev.onset):'brak sygnału'} → ${ev.end?localHour(ev.end):'—'}</strong><em>histereza 65/40</em></div>""",
    """      <div class="fog-card"><small>Kiedy mgła?</small><strong>${ev.onset?localHour(ev.onset)+' → '+(ev.end?localHour(ev.end):'dalej'):'brak sygnału ≥40 w 48 h'}</strong><em>próg operacyjny 40/100</em></div>""",
    "fog timing summary",
)

s = replace_once(
    s,
    """      <div class="fog-card ${riskCss(peak.score)}"><small>Największe ryzyko</small><strong>${fmt0(peak.score)}/100</strong><em>${ev.peakFrom?localHour(ev.peakFrom)+'–'+localHour(ev.peakTo):localHour(peak.t)}</em></div>""",
    """      <div class="fog-card ${riskCss(peak.score)}"><small>Maksimum w 48 h</small><strong>${peak.score>=40?scoreClass(peak.score):'PONIŻEJ PROGU'}</strong><em>${peak.score>=40?fmt0(peak.score)+'/100 · '+(ev.peakFrom?localHour(ev.peakFrom)+'–'+localHour(ev.peakTo):localHour(peak.t)):'brak operacyjnej mgły'}</em></div>""",
    "peak fog summary",
)

s = replace_once(
    s,
    """      hours.innerHTML=future.slice(0,13).map(x=>`<div class="fog-hour ${riskCss(x.score)}"><b>${localHour(x.t)}</b><div class="p">${fmt0(x.score)}/100</div><small>${scoreClass(x.score)}</small><small>${x.type?.text||'—'}</small><small>VIS ${fmtM(x.vis)}</small><small>&lt;1km ${fmt0(x.vis1000)}/100</small></div>`).join('');""",
    """      hours.innerHTML=future.slice(0,13).map(x=>`<div class="fog-hour ${riskCss(x.score)}"><b>${localHour(x.t)}</b><div class="p">${scoreClass(x.score)}</div><small>${x.score>=40?fmt0(x.score)+'/100':'&lt;40 · pominięte'}</small><small>${x.score>=40?(x.type?.text||'—'):'bez sygnału operacyjnego'}</small><small>VIS ${fmtM(x.vis)}</small><small>&lt;1km ${fmt0(x.vis1000)}/100</small></div>`).join('');""",
    "hourly fog cells",
)

p.write_text(s, encoding="utf-8")

p = Path("fog-meteogram-overlay.js")
s = p.read_text(encoding="utf-8")

s = replace_once(s, "const FOG_DRAW_THRESHOLD = 60;", "const FOG_DRAW_THRESHOLD = 40;", "fog draw threshold")
s = replace_once(
    s,
    """if (score >= 75) return 'rgba(208,80,63,.62)';
    if (score >= 60) return 'rgba(216,108,47,.57)';
    return 'rgba(212,154,40,.50)';""",
    """if (score >= 80) return 'rgba(208,80,63,.62)';
    if (score >= 60) return 'rgba(216,108,47,.57)';
    return 'rgba(212,154,40,.50)';""",
    "fog overlay colors",
)
s = replace_once(s, "ctx.fillText('FOG 60',x0-24,baseY);", "ctx.fillText('FOG 40',x0-24,baseY);", "fog scale label")
s = replace_once(s, "słupki = FOG ENGINE, od 60/100", "słupki = FOG ENGINE, od 40/100", "fog legend")
s = replace_once(
    s,
    "if (text === 'FOG ENGINE ≥40/100') text = 'FOG ENGINE ≥60/100';",
    "if (text === 'FOG ENGINE ≥60/100') text = 'FOG ENGINE ≥40/100';",
    "canvas fog legend",
)

# BR is ancillary to FOG; keep its stricter draw threshold, but never show a current BR card below 40.
s = replace_once(
    s,
    "    card.className = 'fog-card ' + (current.score >= 75 ? 'fog-risk-vhigh' : current.score >= 60 ? 'fog-risk-high' : current.score >= 40 ? 'fog-risk-mid' : 'fog-risk-low');",
    "    if (current.score < BR_INFO_THRESHOLD) return;\n    card.className = 'fog-card ' + (current.score >= 80 ? 'fog-risk-vhigh' : current.score >= 60 ? 'fog-risk-high' : 'fog-risk-mid');",
    "br subthreshold suppression",
)

p.write_text(s, encoding="utf-8")
