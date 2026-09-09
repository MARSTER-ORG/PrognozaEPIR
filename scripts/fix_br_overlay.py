from pathlib import Path

p = Path('fog-meteogram-overlay.js')
s = p.read_text(encoding='utf-8')

old = """    return rows.map(row => {
      const score = brScoreForFogRow(row);
      return finite(score) ? {...row,score} : null;
    }).filter(Boolean);"""
new = """    const out = rows.map(row => {
      const score = brScoreForFogRow(row);
      return finite(score) ? {...row,score} : null;
    }).filter(Boolean);
    window.PrognozaEPIRBRSeries = out;
    return out;"""
if old in s:
    s = s.replace(old, new, 1)
elif 'window.PrognozaEPIRBRSeries = out;' not in s:
    raise SystemExit('BR series export hook not found')

old = """    ctx.stroke();
    ctx.setLineDash([]);

    const cp = typeof canvasPalette === 'function' ? canvasPalette() : {muted:'#666',grid2:'#999'};"""
new = """    ctx.stroke();
    ctx.setLineDash([]);
    // Mark every operational BR point, including isolated single-hour signals.
    for (const row of br) {
      if (!finite(row.t) || !finite(row.score) || row.score < BR_DRAW_THRESHOLD) continue;
      const xx = x(row.t);
      const yy = yOnRiskScale(row.score,p);
      ctx.beginPath();
      ctx.arc(xx,yy,3.0,0,Math.PI*2);
      ctx.fillStyle = BR_COLOR;
      ctx.fill();
    }

    const cp = typeof canvasPalette === 'function' ? canvasPalette() : {muted:'#666',grid2:'#999'};"""
if old in s:
    s = s.replace(old, new, 1)
elif 'including isolated single-hour signals' not in s:
    raise SystemExit('BR draw hook not found')

old = """    const card = document.createElement('div');
    card.id = 'brCard';
    if (current.score < BR_INFO_THRESHOLD) return;
    card.className = 'fog-card ' + (current.score >= 80 ? 'fog-risk-vhigh' : current.score >= 60 ? 'fog-risk-high' : 'fog-risk-mid');
    card.innerHTML = '<small>Zamglenie · BR</small><strong>' + Math.round(current.score) + '/100</strong>' +
      '<em>' + brRiskText(current.score) + ' · szczyt ' + Math.round(peak.score) + '/100 ' + localHour(peak.t) + '</em>';"""
new = """    const card = document.createElement('div');
    card.id = 'brCard';
    const signal = Math.max(current.score, peak.score);
    if (signal < BR_INFO_THRESHOLD) return;
    card.className = 'fog-card ' + (signal >= 80 ? 'fog-risk-vhigh' : signal >= 60 ? 'fog-risk-high' : 'fog-risk-mid');
    card.innerHTML = '<small>Zamglenie · BR</small><strong>teraz ' + Math.round(current.score) + '/100</strong>' +
      '<em>' + brRiskText(signal) + ' · szczyt ' + Math.round(peak.score) + '/100 ' + localHour(peak.t) + '</em>';"""
if old in s:
    s = s.replace(old, new, 1)
elif 'const signal = Math.max(current.score, peak.score);' not in s:
    raise SystemExit('BR card hook not found')

s = s.replace('słupki = FOG ENGINE, od 40/100', 'słupki = FOG ENGINE, od 60/100')
s = s.replace("if (text === 'FOG ENGINE ≥60/100') text = 'FOG ENGINE ≥40/100';",
              "if (text === 'FOG ENGINE ≥40/100') text = 'FOG ENGINE ≥60/100';")

p.write_text(s, encoding='utf-8')
