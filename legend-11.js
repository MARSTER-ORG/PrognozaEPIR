'use strict';
(() => {
  // RADAR UI only: compact 11-step CMAX legend. The underlying CMAX decoder
  // keeps the full POLRAD palette so point values remain as accurate as before.
  const LEGEND_11 = [
    ['≥59', '#f58cff'],
    ['53–58', '#ff19cc'],
    ['47–52', '#e60059'],
    ['41–46', '#ff1600'],
    ['35–40', '#ff8800'],
    ['29–34', '#fff200'],
    ['23–28', '#fffbd8'],
    ['17–22', '#b8f4f1'],
    ['11–16', '#1bc8f0'],
    ['5–10', '#0033e8'],
    ['0–4', '#0000aa']
  ];

  const style = document.createElement('style');
  style.id = 'epirLegend11Style';
  style.textContent = `
    .legend-dbz{font-size:7px!important;line-height:1.05!important;padding:4px 5px!important;min-width:82px!important;max-height:none!important;overflow:visible!important}
    .legend-dbz>b{display:block;font-size:8px!important;margin-bottom:3px!important}
    .legend-dbz .dbz-grid{display:grid!important;grid-template-columns:1fr!important;gap:1px!important}
    .legend-dbz .dbz-row{display:flex!important;align-items:center!important;gap:3px!important;white-space:nowrap!important;margin:0!important}
    .legend-dbz .sw{width:11px!important;height:6px!important;flex:0 0 11px!important;margin:0!important}
    @media(max-width:560px){.legend-dbz{font-size:6.5px!important;padding:3px 4px!important;min-width:78px!important}.legend-dbz>b{font-size:7px!important}}
  `;
  document.head.appendChild(style);

  function renderLegend11(){
    const legend = document.querySelector('.legend-dbz');
    if (!legend) return;
    legend.dataset.fullScale = '1';
    legend.dataset.steps = '11';
    legend.innerHTML = '<b>POLRAD dBZ</b><div class="dbz-grid">' + LEGEND_11.map(([label,color]) =>
      '<div class="dbz-row"><span class="sw" style="background:'+color+'"></span><span>'+label+'</span></div>'
    ).join('') + '</div>';
  }

  renderLegend11();
  setTimeout(renderLegend11,250);
  setTimeout(renderLegend11,800);
  setTimeout(renderLegend11,1600);
  window.PrognozaEPIRLegend11 = {render:renderLegend11,steps:LEGEND_11.slice()};
})();
