from pathlib import Path

POLICY = Path('taf-generator-policy.js')
ADAPTER = Path('taf-hybrid-adapter.js')
TAF_HTML = Path('taf.html')
TESTS = Path('tests/taf-hybrid-engine.test.js')


def replace_once(text, old, new, name):
    if old not in text:
        if new in text:
            return text
        raise SystemExit(f'{name}: anchor not found')
    return text.replace(old, new, 1)


s = POLICY.read_text(encoding='utf-8')
if "const VERSION='3.2.0';" not in s:
    s = replace_once(s, "const VERSION='3.1.1';", "const VERSION='3.2.0';", 'policy version')

    anchor = """  function reconcileBase(result,plan,cfg,msaFt){
    const original=result.hourly?.[0]||result.base?.state;if(!original)return null;const base={...original,clouds:hourClouds(original).map(c=>({...c}))};
    const hs=(result.hourly||[]).slice(0,(cfg.shortHorizon||DEFAULTS.shortHorizon).hours),windStable=hs.length>1&&!hs.slice(1).some(h=>windNeedsGroup(hs[0],h));
    if(windStable&&(cfg.shortHorizon||DEFAULTS.shortHorizon).blendWind){const w=blendedShortWind(hs);if(w){base.windKt=w.windKt;if(finite(w.windDir))base.windDir=w.windDir;if(finite(w.gustKt))base.gustKt=w.gustKt;}}
    if(plan?.active){const lim=cloudThresholds(msaFt).cavok,minFt=(cfg.shortHorizon||DEFAULTS.shortHorizon).weakCloudMinFt;base.clouds=base.clouds.filter(c=>c.type||c.ft>=lim||c.ft<minFt||(c.okta||amountMin(c.cover))>=5);base.__tafCloudsAuthoritative=true;}
    return base;
  }
"""
    addition = anchor + """
  // Keep the hourly guidance view on the same accepted state as the TAF encoder.
  // Raw model clouds are retained separately for diagnostics.
  function applyShortHorizonToHourly(result,plan,cfg,msaFt){
    if(!plan?.active||!Array.isArray(result?.hourly))return 0;
    const sh=cfg.shortHorizon||DEFAULTS.shortHorizon,lim=cloudThresholds(msaFt).cavok;let changed=0;
    for(let i=0;i<Math.min(sh.hours,result.hourly.length);i++){
      const h=result.hourly[i];if(!weakClearCompatibleHour(h,msaFt,cfg))continue;
      const raw=hourClouds(h).map(c=>({...c})),filtered=raw.filter(c=>c.type||c.ft>=lim||c.ft<sh.weakCloudMinFt||(c.okta||amountMin(c.cover))>=5);
      if(filtered.length!==raw.length){
        h.__tafRawClouds=raw;
        h.clouds=filtered;
        h.__tafCloudsAuthoritative=true;
        h.__tafShortHorizonCorrected=true;
        changed++;
      }
    }
    return changed;
  }
  function displayForHour(h,msaFt){
    const cavok=strictCavokEligible(h,msaFt),wx=encodedWxForHour(h);
    return{cavok,wind:windFromHour(h),visibility:encodedVis(h?.visM),weather:wx,clouds:cavok?'CAVOK':(strictNscEligible(h,msaFt)?'NSC':encodeCloudsStrict(h,msaFt)),corrected:!!h?.__tafShortHorizonCorrected};
  }
  function attachHourlyDisplay(result,msaFt){
    for(const h of result.hourly||[])h.tafDisplay=displayForHour(h,msaFt);
    if(result.base?.state)result.base.display=displayForHour(result.base.state,msaFt);
  }
"""
    s = replace_once(s, anchor, addition, 'reconcileBase')

    old = """    const cfg=cfgOf(ctx.config),rows=ctx.rows||result.hourly.map(h=>h.sourceRow).filter(Boolean),msaFt=finite(+ctx.msaFt)?+ctx.msaFt:finite(+result?.diagnostics?.msaFt)?+result.diagnostics.msaFt:null;
    const advisoryPlan=dominantClearPlan(rows,result.start,cfg),shortPlan=shortHorizonBasePlan(result,ctx,cfg,msaFt),suppressed=[],base=reconcileBase(result,shortPlan,cfg,msaFt);if(base){result.base=result.base||{};result.base.state=base;result.base.text=encodeStateStrict(base,msaFt);}
"""
    new = """    const cfg=cfgOf(ctx.config),rows=ctx.rows||result.hourly.map(h=>h.sourceRow).filter(Boolean),msaFt=finite(+ctx.msaFt)?+ctx.msaFt:finite(+result?.diagnostics?.msaFt)?+result.diagnostics.msaFt:null;
    const advisoryPlan=dominantClearPlan(rows,result.start,cfg),shortPlan=shortHorizonBasePlan(result,ctx,cfg,msaFt),suppressed=[],correctedHours=applyShortHorizonToHourly(result,shortPlan,cfg,msaFt),base=reconcileBase(result,shortPlan,cfg,msaFt);if(base){result.base=result.base||{};result.base.state=base;result.base.text=encodeStateStrict(base,msaFt);}
"""
    s = replace_once(s, old, new, 'postprocess prelude')
    s = replace_once(s, 'result.groups=groups;result.taf=rebuildTaf(result);', 'result.groups=groups;attachHourlyDisplay(result,msaFt);result.taf=rebuildTaf(result);', 'hourly display attachment')
    s = s.replace('result.diagnostics.shortHorizonBase=shortPlan;', 'result.diagnostics.shortHorizonBase=shortPlan?{...shortPlan,correctedHours}:shortPlan;', 1)
    s = s.replace('shortHorizonBase:shortPlan,dominantClearAdvisory', 'shortHorizonBase:shortPlan?{...shortPlan,correctedHours}:shortPlan,dominantClearAdvisory', 1)
    s = s.replace('shortHorizonBasePlan,reconcileBase,postprocessResult', 'shortHorizonBasePlan,reconcileBase,applyShortHorizonToHourly,displayForHour,postprocessResult', 1)
    s = s.replace('20260913-short-horizon-v6', '20260913-hourly-sync-v7')
POLICY.write_text(s, encoding='utf-8')

s = ADAPTER.read_text(encoding='utf-8')
old = """    if($('hours'))$('hours').innerHTML=result.hourly.map(h=>`<tr><td>${pad(new Date(h.t).getUTCHours())}:00 UTC</td><td>${windText(h,!!result.diagnostics?.vrb02)}</td><td>${visText(h.visM)}</td><td>${wxText(h)||'—'}</td><td>${cloudText(h)}</td><td>${finite(h.ceilingFt)?Math.round(h.ceilingFt)+' ft':'—'}</td><td>${Math.round((h.prob?.precip||0)*100)}% / TS ${Math.round((h.prob?.ts||0)*100)}%</td><td>FG ${Math.round((h.prob?.fog||0)*100)}% · LOW VIS ${Math.round((h.prob?.lowVis||0)*100)}%</td><td>${upstreamText(h)}</td></tr>`).join('');
"""
new = """    if($('hours'))$('hours').innerHTML=result.hourly.map((h,i)=>{const d=i===0&&result.base?.display?result.base.display:(h.tafDisplay||{}),wind=d.wind||windText(h,!!result.diagnostics?.vrb02),vis=d.visibility||visText(h.visM),wx=d.weather??wxText(h),clouds=d.clouds||cloudText(h),mark=d.corrected?' ✓':'';return `<tr><td>${pad(new Date(h.t).getUTCHours())}:00 UTC</td><td>${wind}</td><td>${vis}</td><td>${wx||'—'}</td><td>${clouds}${mark}</td><td>${finite(h.ceilingFt)?Math.round(h.ceilingFt)+' ft':'—'}</td><td>${Math.round((h.prob?.precip||0)*100)}% / TS ${Math.round((h.prob?.ts||0)*100)}%</td><td>FG ${Math.round((h.prob?.fog||0)*100)}% · LOW VIS ${Math.round((h.prob?.lowVis||0)*100)}%</td><td>${upstreamText(h)}</td></tr>`;}).join('');
"""
if 'result.base?.display' not in s:
    s = replace_once(s, old, new, 'adapter hourly renderer')
ADAPTER.write_text(s, encoding='utf-8')

# Ensure the hidden meteogram is refreshed when the TAF page loads, so it receives
# the same current consensus corrections as the visible meteogram.
s = TAF_HTML.read_text(encoding='utf-8')
if 'index.html?v=20260913-hourly-sync-v7' not in s:
    s = replace_once(s, '<iframe id="engine" src="index.html"', '<iframe id="engine" src="index.html?v=20260913-hourly-sync-v7"', 'hidden meteogram iframe')
TAF_HTML.write_text(s, encoding='utf-8')

s = TESTS.read_text(encoding='utf-8')
s = s.replace("assert.equal(P.VERSION,'3.1.1');", "assert.equal(P.VERSION,'3.2.0');", 1)
anchor = """assert.equal(r.diagnostics.shortHorizonBase.active,true);
assert.match(r.base.text,/\\bCAVOK\\b/);
assert.ok(r.base.state.windKt>5&&r.base.state.windKt<7,'base wind is blended over short horizon, not copied from one hour');
"""
extra = anchor + """assert.equal(r.hourly[0].tafDisplay.cavok,true,'hourly table guidance follows accepted short-horizon correction');
assert.equal(r.hourly[0].tafDisplay.clouds,'CAVOK');
assert.ok(r.hourly[0].__tafShortHorizonCorrected,'corrected hour is explicitly marked');
assert.ok(Array.isArray(r.hourly[0].__tafRawClouds)&&r.hourly[0].__tafRawClouds.length>0,'raw clouds are retained for diagnostics');
"""
if 'hourly table guidance follows accepted short-horizon correction' not in s:
    s = replace_once(s, anchor, extra, 'short-horizon regression test')
TESTS.write_text(s, encoding='utf-8')

print('TAF hourly synchronization patch applied')
