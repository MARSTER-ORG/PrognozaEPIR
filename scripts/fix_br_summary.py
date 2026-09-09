from pathlib import Path

p = Path('fog-meteogram-overlay.js')
s = p.read_text(encoding='utf-8')

start = s.index('  function renderBrCard() {')
end = s.index('\n  function installBrHoverTooltip()', start)

new_block = '''  function brOperationalText(score) {
    if (!finite(score)) return 'BRAK DANYCH';
    if (score < 40) return 'NIE';
    if (score < 60) return 'MOŻLIWE';
    if (score < 80) return 'PRAWDOPODOBNE';
    return 'BARDZO PRAWDOPODOBNE';
  }

  function renderBrCard() {
    const summary = document.getElementById('fogSummary');
    const rows = brSeries();
    if (!summary || !rows.length) return;
    document.getElementById('brCard')?.remove();
    const now = Date.now();
    const current = rows.reduce((a,b) => Math.abs(b.t-now) < Math.abs(a.t-now) ? b : a, rows[0]);
    const future = rows.filter(row => row.t >= now-HOUR && row.t <= now+12*HOUR);
    const peak = future.reduce((a,b) => !a || b.score > a.score ? b : a, null) || current;
    const card = document.createElement('div');
    card.id = 'brCard';
    card.className = 'fog-card ' + (current.score >= 80 ? 'fog-risk-vhigh' : current.score >= 60 ? 'fog-risk-high' : current.score >= 40 ? 'fog-risk-mid' : '');
    const currentDetail = current.score >= BR_INFO_THRESHOLD
      ? Math.round(current.score) + '/100'
      : 'wynik <40/100 pominięty';
    const peakDetail = peak.score >= BR_INFO_THRESHOLD
      ? ' · maks. 12 h ' + Math.round(peak.score) + '/100 ' + localHour(peak.t)
      : ' · brak sygnału ≥40 w 12 h';
    card.innerHTML = '<small>ZAMGLENIE (BR) W CIĄGU NAJBLIŻSZEJ GODZINY</small><strong>' + brOperationalText(current.score) + '</strong>' +
      '<em>' + currentDetail + peakDetail + '</em>';
    summary.appendChild(card);
  }
'''

s = s[:start] + new_block + s[end:]
p.write_text(s, encoding='utf-8')
