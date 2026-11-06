#!/usr/bin/env python3
"""Conservative cloud-amount correction from past issued forecasts; forward holdout."""
import json
import math
from collections import defaultdict
from datetime import datetime, timezone, timedelta
import model_verification as mv
import consensus_cloud_two_month_audit as audit

OUT=mv.LEARNING/"consensus-cloud-calibration.json"
NOW=mv.utcnow()
END=NOW-timedelta(hours=1)
CUTOFF=END-timedelta(days=21)
START=END-timedelta(days=61)
SHIFTS=[-.0,-.25,-.5,-.75,-1.,-1.25,-1.5,.25,.5,.75,1.,1.25,1.5]

def corrected(x,delta):
    if not mv.finite(x): return None
    return max(0,min(8,math.floor(max(0,min(100,float(x)))/12.5+delta+.5)))

def distance(x,actual):
    if isinstance(actual,tuple):
        return max(actual[0]-x,0,x-actual[1])
    return abs(x-actual)

def metric(rows,delta):
    return sum(distance(corrected(p,delta),o) for _,p,o in rows)/len(rows) if rows else None

def pod(rows,delta):
    positives=[(p,o) for _,p,o in rows if not isinstance(o,tuple) and o>=5]
    return sum(corrected(p,delta)>=5 for p,_ in positives)/len(positives) if positives else None

def fit(rows,kind):
    tr=[x for x in rows if x[0]<CUTOFF]
    val=[x for x in rows if x[0]>=CUTOFF]
    minimum=(60,20) if kind=="total" else (20,10)
    base=metric(val,0)
    out={"active":False,"shift_okta":0,"train_n":len(tr),"holdout_n":len(val),"baseline_holdout_mae":round(base,3) if base is not None else None}
    if len(tr)<minimum[0] or len(val)<minimum[1]:
        out["reason"]="insufficient_data";return out
    choice=min(SHIFTS,key=lambda s:(metric(tr,s)+.05*abs(s),abs(s)))
    test=metric(val,choice)
    gain=base-test
    out.update({"candidate_shift_okta":choice,"candidate_holdout_mae":round(test,3),"holdout_mae_gain":round(gain,3)})
    if abs(choice)<.01 or gain<(.05 if kind=="total" else .08):
        out["reason"]="holdout_not_improved";return out
    if kind=="total":
        before,after=pod(val,0),pod(val,choice)
        out["bkn_ovc_pod_before"]=round(before,3) if before is not None else None
        out["bkn_ovc_pod_after"]=round(after,3) if after is not None else None
        if before is not None and after is not None and after<before-.03:
            out["reason"]="bkn_ovc_detection_regression";return out
    out.update({"active":True,"shift_okta":choice,"reason":"out_of_sample_validated"})
    return out

def main():
    _,_,sel=audit.scan_archived_forecasts(start=START,end=END)
    metars,synops=mv.build_observation_maps()
    samples=defaultdict(list)
    for (bucket,t),(_,c,_) in sel.items():
        date=mv.parse_dt(t)
        if not date:continue
        phase="night" if date.hour<6 or date.hour>=18 else "day"
        s=synops.get(t)
        n=s.get("total_cloud_oktas") if s else None
        if mv.finite(n) and 0<=n<=8 and mv.finite(c.get("cloud_total_pct")):
            for label in ("all",phase):
                samples[bucket,"total",label].append((date,c["cloud_total_pct"],n))
        obs,_,_=audit.observed_cloud_layers(metars.get(t))
        if obs["mid"] and mv.finite(c.get("mid_pct")):
            samples[bucket,"mid","all"].append((date,c["mid_pct"],obs["mid"]))
    buckets={}
    for _,_,b,_ in mv.LEAD_BUCKETS:
        buckets[b]={
            "total":{p:fit(samples[b,"total",p],"total") for p in ("all","night","day")},
            "mid":{"all":fit(samples[b,"mid","all"],"mid")}}
    result={"schema":"prognozaepir-consensus-cloud-calibration-v1",
       "generated_at":mv.iso(mv.utcnow()),"station":"EPIR",
       "training_start":mv.iso(START),"training_before":mv.iso(CUTOFF),"holdout_from":mv.iso(CUTOFF),"window_end":mv.iso(END),
       "method":"Base-weight historical consensus, time-separated training and later holdout, interval-aware METAR, bounded shifts",
       "lead_buckets":buckets,
       "applies_to":["surface cloud_cover","surface cloud_cover_mid"],
       "excluded":["pressure-level profile","0-450m cloud base","aviation ceiling","fog engines"]}
    OUT.parent.mkdir(parents=True,exist_ok=True)
    OUT.write_text(json.dumps(result,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")
    print("Cloud holdout:",json.dumps({b:{k:{p:[v["active"],v["shift_okta"],v.get("holdout_mae_gain")] for p,v in x.items()} for k,x in q.items()} for b,q in buckets.items()},ensure_ascii=False))
if __name__=="__main__": main()
