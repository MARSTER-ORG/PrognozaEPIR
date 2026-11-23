#!/usr/bin/env python3
"""Offline independent type audit. Never promotes weights or fabricates a replay."""
from __future__ import annotations
import argparse
from collections import Counter
from datetime import timedelta
import json
from pathlib import Path
import subprocess
import build_precipitation_learning as p
import model_verification as mv


def observed_code(label):
    wet,phase,char,*_=label
    if not wet:return 'DRY'
    if char=='thunder':return 'TS'
    if phase=='drizzle':return 'DZ'
    if phase in ('rain','snow','mixed') and char in ('non_showery','showery'):
        return ('SH' if char=='showery' else '')+{'rain':'RA','snow':'SN','mixed':'RASN'}[phase]
    if phase in ('freezing','ice','hail','hail_or_pellets'):
        return {'freezing':'FZ','ice':'PL','hail':'GR','hail_or_pellets':'GS'}[phase]
    return None


def normalize(code):
    if code in ('TS','TSRA','TSSN','TSGR'):return 'TS'
    if code in ('FZDZ','FZRA'):return 'FZ'
    if code=='SHGR':return 'GR'
    if code=='SHGS':return 'GS'
    if code=='SG':return 'SN'
    return code or 'DRY'


def evaluate(pairs):
    matrix=Counter(pairs);classes=sorted({y for y,_ in pairs}|{v for _,v in pairs})
    scores={}
    for cls in classes:
        tp=matrix[cls,cls];fp=sum(n for (y,v),n in matrix.items() if v==cls and y!=cls)
        fn=sum(n for (y,v),n in matrix.items() if y==cls and v!=cls)
        scores[cls]={'observed':tp+fn,'predicted':tp+fp,'precision':tp/(tp+fp) if tp+fp else None,
            'recall':tp/(tp+fn) if tp+fn else None,'f1':2*tp/(2*tp+fp+fn) if 2*tp+fp+fn else None,
            'insufficient':tp+fn<30 or tp+fp<30}
    hits=sum(y==v for y,v in pairs);n=len(pairs)
    return {'n':n,'accuracy':hits/n if n else None,'misclassification_rate':1-hits/n if n else None,
        'confusion':{y:{v:matrix[y,v] for v in classes if matrix[y,v]} for y in classes if any(a==y for a,_ in matrix)},
        'class_metrics':scores,'note':'Class sample flag uses 30 observations/predictions; hours within a weather episode are correlated.'}


def run(output,now):
    labels,secondary=p.hour_labels(mv.all_jsonl(mv.METAR_DIR)+mv.all_jsonl(mv.SPECI_DIR),mv.all_jsonl(mv.SYNOP_DIR),now)
    forecasts=mv.load_forecasts();rows=p.cases(forecasts,labels,now)
    times=sorted({t for t,_,_,_ in rows})
    cut=times[int(.8*len(times))] if times else now
    training=[r for r in rows if r[0]<cut-timedelta(days=1)]
    holdout=[r for r in rows if r[0]>=cut]
    inputs=[[{'id':m,'weather_code':f.get('weather_code'),'precipitation':f['precipitation_mm'],'w':mv.MODEL_META[m][1]} for m,f in models.items()] for _,_,_,models in holdout]
    # Run the actual JavaScript classifier and consensus with fixed base weights.
    js="""const fs=require('fs'),p=require('./meteogram-precipitation-types.js');
const inputs=JSON.parse(fs.readFileSync(0,'utf8'));
console.log(JSON.stringify(inputs.map(ms=>({aggregate:p.aggregate(ms)?.code||null,
 models:Object.fromEntries(ms.map(m=>[m.id,p.classify(m)?.code||null]))}))));"""
    predictions=json.loads(subprocess.run(['node','-e',js],input=json.dumps(inputs),text=True,cwd=mv.ROOT,check=True,capture_output=True).stdout)
    buckets={};permodel={};unknown=Counter()
    for (_,bucket,label,models),pred in zip(holdout,predictions):
        truth=observed_code(label)
        if truth is None:unknown[bucket]+=1;continue
        buckets.setdefault(bucket,[]).append((truth,normalize(pred['aggregate'])))
        for m,code in pred['models'].items():permodel.setdefault(bucket,{}).setdefault(m,[]).append((truth,normalize(code)))
    known=sum(len(v) for v in buckets.values())
    report={'schema':'prognozaepir-precipitation-qualification-v1','generated_at':mv.iso(now),'station':'EPIR',
        'source_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=mv.ROOT,text=True).strip(),
        'mode':'shadow_only','active':False,
        'split':{'cutoff':mv.iso(cut),'embargo_hours':24,'training_cases':len(training),'holdout_cases':len(holdout),
            'training_used_for_tuning':False,'first_valid':mv.iso(times[0]) if times else None,'last_valid':mv.iso(times[-1]) if times else None},
        'observations':{'wet_hours':sum(v[0] for v in labels.values()),'dry_hours':sum(not v[0] for v in labels.values()),
            'neighbour_synop_positive_hours':len(secondary),'neighbours_pooled':False,'exact_type_holdout_cases':known,'unknown_type_excluded':dict(unknown)},
        'baseline':'Actual JS classify/aggregate model-code hints; fixed base weights, NOT the historical adaptive browser consensus or a >=0.1 mm/h occurrence forecast. WMO can indicate trace precipitation at zero rounded amount. DRY/unknown AUTO rules as in precipitation learning.',
        'holdout_by_lead':{k:{**evaluate(v),'wet_reference':evaluate([(y,pred) for y,pred in v if y!='DRY'])} for k,v in buckets.items()},
        'models_by_lead':{b:{m:evaluate(v) for m,v in ms.items()} for b,ms in permodel.items()},
        'before_after':{'available':False,'reason':'No complete historical runtime input envelopes: model archive lacks pressure-level cloud profiles, rain/showers/snowfall partition and contemporaneous radar/convection evidence. Cloud-only profile archive has no saved runtime precipitation decision. Do not fabricate missing inputs or call this baseline an after-engine replay.'},
        'weight_activation':'None. Existing precipitation-learning.json remains shadow_only; no type weights promoted.',
        'limits':['Instantaneous present-weather labels, not measured hourly accumulation.',
            'Forecast release availability approximated by archived run_time; model_run_time and archive_time retained by sources, no reanalysis imported.',
            'Retrospective audit after heuristic design; a prospective unseen test set is still needed.',
            'Different lead bins reuse weather hours; do not pool sample counts as independent events.']}
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,ensure_ascii=False,indent=2,allow_nan=False)+'\n')
    print(json.dumps({'output':str(output),'split':report['split'],'observations':report['observations'],
        'holdout':{b:{k:v[k] for k in ('n','accuracy','misclassification_rate')} for b,v in report['holdout_by_lead'].items()}},indent=2))

if __name__=='__main__':
    cli=argparse.ArgumentParser();cli.add_argument('--output',type=Path,default=mv.ROOT/'docs/qa/precipitation-history-20261123.json')
    args=cli.parse_args();run(args.output,mv.utcnow())
