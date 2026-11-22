#!/usr/bin/env python3
"""Independent, offline precipitation learning; outputs shadow candidates only."""
from __future__ import annotations
import json
import math
import re
from collections import Counter, defaultdict
from datetime import timedelta
from statistics import median
import model_verification as mv

OUT = mv.LEARNING / "precipitation-learning.json"
H = timedelta(hours=1)
THRESHOLDS = (.10, .20, .30, .40, .50, .60, .70)
PHASES = ("rain", "drizzle", "snow", "mixed", "freezing", "ice", "hail", "hail_or_pellets")
TOKEN = re.compile(r"^[+-]?(?P<desc>SH|TS|FZ)?(?P<phase>(?:DZ|RA|SN|SG|PL|GR|GS|UP)+)$")

def number(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)

def metar_label(row):
    raw = str(row.get("canonical_raw") or row.get("raw") or "").upper().split("RMK")[0].replace("=", "")
    tokens = raw.split()
    if not tokens or "NIL" in tokens:
        return None
    phases, characters = set(), set()
    for token in tokens:
        match = TOKEN.fullmatch(token)
        if not match:
            continue
        p, d = match["phase"], match["desc"]
        codes = re.findall(r"DZ|RA|SN|SG|PL|GR|GS|UP", p)
        if "UP" in codes:
            phases.add("unknown")
        elif "GR" in codes:
            phases.add("hail")
        elif "GS" in codes:
            phases.add("hail_or_pellets")
        elif d == "FZ":
            phases.add("freezing")
        elif "RA" in codes and "SN" in codes:
            phases.add("mixed")
        elif "PL" in codes:
            phases.add("ice")
        elif "SN" in codes or "SG" in codes:
            phases.add("snow")
        elif "RA" in codes:
            phases.add("rain")
        elif "DZ" in codes:
            phases.add("drizzle")
        if d == "SH":
            characters.add("showery")
        elif d == "TS":
            characters.add("thunder")
        elif "AUTO" not in tokens:
            characters.add("non_showery")
    if phases:
        return True, next(iter(phases)) if len(phases)==1 else "unknown", next(iter(characters)) if len(characters)==1 else "unknown"
    # Recent precipitation is not proof of dry conditions over the previous hour.
    if any(t.startswith('RE') and TOKEN.fullmatch(t[2:]) for t in tokens):
        return None
    # Automatic stations may omit present weather; no negative label without
    # an independently proven observing capability. RE/VC are not local current precipitation.
    if "AUTO" in tokens or any("/" in t and (t.startswith("//") or t=="////") for t in tokens):
        return None
    if "CAVOK" in tokens or "NSW" in tokens or (
        any(re.fullmatch(r"(?:VRB|\d{3})\d{2,3}(?:G\d{2,3})?(?:KT|MPS)",t) for t in tokens)
        and any(re.fullmatch(r"Q\d{4}|A\d{4}",t) for t in tokens)
        and any(re.fullmatch(r"\d{4}",t) for t in tokens)
    ):
        return False, None, None
    return None

def synop_label(row):
    # Only explicit manual WMO 4677 (iX=1), not automatic table 4680.
    raw = str(row.get("canonical_raw") or row.get("raw") or "").upper()
    tokens = raw.split()
    try:
        i=tokens.index("12342")
        if not re.fullmatch(r"[0-9/]{5}",tokens[i+1]) or tokens[i+1][1]!="1":
            return None
    except (ValueError, IndexError):
        return None
    ww=row.get("present_weather_code")
    if not isinstance(ww,int):
        return None
    if 50<=ww<=59:return True,"freezing" if ww in (56,57) else "unknown" if ww in (58,59) else "drizzle","non_showery"
    if 60<=ww<=69:return True,"freezing" if ww in (66,67) else "mixed" if ww in (68,69) else "rain","non_showery"
    if 70<=ww<=75 or ww==77:return True,"snow","non_showery"
    if ww==79:return True,"ice","non_showery"
    if 80<=ww<=82:return True,"rain","showery"
    if ww in (83,84):return True,"mixed","showery"
    if ww in (85,86):return True,"snow","showery"
    if ww in (87,88):return True,"hail_or_pellets","showery"
    if ww in (89,90):return True,"hail","showery"
    if ww in (91,92):return True,"rain","unknown"
    if ww in (93,94):return True,"unknown","unknown"
    if ww in (95,97):return True,"unknown","thunder"
    if ww in (96,99):return True,"hail","thunder"
    # Past-hour phenomena: some explicitly indicate precipitation which ended.
    if ww in (20,21,22,23,24,25,26,27):
        return True,"unknown","unknown"
    return None

def forecast_phase(f):
    w=f.get("weather_code")
    if not number(w) or w!=int(w):return None,None
    if w in (51,53,55):return "drizzle","non_showery"
    if w in (56,57,66,67):return "freezing","non_showery"
    if w in (61,63,65):return "rain","non_showery"
    if w in (71,73,75,77):return "snow","non_showery"
    if w in (80,81,82):return "rain","showery"
    if w in (85,86):return "snow","showery"
    if w in (68,69):return "mixed","non_showery"
    if w in (83,84):return "mixed","showery"
    if w in (87,88):return "hail_or_pellets","showery"
    if w in (89,90):return "hail","showery"
    if w==79:return "ice","non_showery"
    if w==95:return None,"thunder"
    if w in (96,99):return "hail","thunder"
    return None,None

def hour_labels(metars,synops,now):
    # Forecast accumulation ending at T is verified with samples in (T-1h,T].
    # Select corrections, deduplicate hours, and retain missingness.
    points={}
    for row in metars:
        if mv.observation_station(row)!="EPIR":continue
        t=mv.parse_dt(row.get("obs_time"))
        if not t or t>now:continue
        old=points.get(t)
        if old is None or mv.is_corrected_report(row):
            points[t]=row
    groups=defaultdict(list)
    for t,row in points.items():
        end=t.replace(minute=0,second=0,microsecond=0)
        if t>end:end+=H
        if end<=now:groups[end].append((t,metar_label(row)))
    labels={}
    for end,items in groups.items():
        positives=[v for _,v in items if v and v[0]]
        if positives:
            # Instantaneous weather codes are compared only with near-end observations;
            # an earlier shower can prove hourly occurrence, not the phase at T.
            endpoint=[v for t,v in items if v and v[0] and end-t<=timedelta(minutes=5)]
            phase={v[1] for v in endpoint}; char={v[2] for v in endpoint}
            labels[end]=(True,next(iter(phase)) if len(phase)==1 else "unknown",next(iter(char)) if len(char)==1 else "unknown","EPIR_METAR")
        else:
            dry=[t for t,v in items if v and not v[0]]
            # Require coverage across the hour; unknown AUTO reports do not vote dry.
            if len(dry)>=2 and min(dry)<=end-timedelta(minutes=25) and max(dry)>=end-timedelta(minutes=5) and all(v is not None for _,v in items):
                labels[end]=(False,None,None,"EPIR_METAR")
    secondary={}
    for row in synops:
        if mv.observation_station(row)!="12342":continue
        t=mv.parse_dt(row.get("obs_time"))
        if not t or t>now or t.minute or t.second:continue
        v=synop_label(row)
        if v:secondary[t]=(*v,"SYNOP_12342_POSITIVE_ONLY")
    return labels,secondary

def counts(pairs):
    h=m=f=c=0
    for p,y in pairs:
        if p and y:h+=1
        elif not p and y:m+=1
        elif p and not y:f+=1
        else:c+=1
    def ratio(a,b):return round(a/b,5) if b else None
    return dict(n=h+m+f+c,hits=h,misses=m,false_alarms=f,correct_negatives=c,
                pod=ratio(h,h+m),far=ratio(f,h+f),csi=ratio(h,h+m+f),bias=ratio(h+f,h+m),
                balanced_accuracy=round((h/(h+m)+c/(f+c))/2,5) if h+m and f+c else None)

def cases(forecasts,labels,now):
    grouped=defaultdict(dict)
    for f in forecasts:
        model=f.get("model")
        if model not in mv.MODEL_META:continue
        valid=mv.parse_dt(f.get("valid_time")); run=mv.parse_dt(f.get("run_time"))
        rr=f.get("precipitation_mm")
        if not valid or not run or valid not in labels or valid>now or run>valid-H or not number(rr) or rr<0:continue
        lead=(valid-run).total_seconds()/3600
        bucket=mv.lead_bucket(lead)
        if not bucket:continue
        # One sample per model, valid hour, lead bin. Choose the archived
        # forecast closest to the nominal lead, never a later observation.
        target=mv.bucket_target(bucket)
        key=(valid,bucket)
        distance=abs(lead-target)
        old=grouped[key].get(model)
        if old is None or (distance,run)<(old[0],old[1]):
            grouped[key][model]=(distance,run,f)
    return [(t,b,labels[t],{m:v[2] for m,v in models.items()})
            for (t,b),models in sorted(grouped.items()) if len(models)>=3]

def probability(models,factors):
    weights={k:mv.MODEL_META[k][1]*factors.get(k,1.0) for k in models}
    sw=sum(weights.values())
    return sum(weights[k] for k,f in models.items() if f["precipitation_mm"]>=.1)/sw

def baseline_amount(models):
    sw=sum(mv.MODEL_META[k][1] for k in models)
    return sum(mv.MODEL_META[k][1]*f["precipitation_mm"] for k,f in models.items())/sw

def fit_factors(rows):
    stats={}
    for model in mv.MODEL_META:
        pairs=[(m[model]["precipitation_mm"]>=.1,lab[0]) for _,_,lab,m in rows if model in m]
        stats[model]=counts(pairs)
    eligible={k:s["balanced_accuracy"] for k,s in stats.items() if s["balanced_accuracy"] is not None and s["hits"]+s["misses"]>=20 and s["false_alarms"]+s["correct_negatives"]>=20}
    center=median(eligible.values()) if len(eligible)>=3 else None
    factors={}
    if center is not None:
        for k,v in eligible.items():
            n=stats[k]["hits"]+stats[k]["misses"]
            shrink=min(1,n/100)
            factors[k]=round(max(.75,min(1.25,1+(v-center)*shrink)),4)
    return factors,stats

def metrics(rows,factors,threshold,amount=False):
    pairs=[];errors=[]
    for _,_,lab,m in rows:
        pr=probability(m,factors); y=lab[0]
        pairs.append(((baseline_amount(m)>=.1) if amount else pr>=threshold,y))
        errors.append((pr-int(y))**2)
    return {**counts(pairs),"brier":round(sum(errors)/len(errors),6) if errors else None}

def phase_audit(rows):
    by=defaultdict(Counter); character=defaultdict(Counter)
    for _,_,lab,models in rows:
        if not lab[0]:continue
        for model,f in models.items():
            phase,char=forecast_phase(f)
            # WMO code is instantaneous; report conditional agreement, not hourly amount skill.
            if lab[1] in PHASES:by[model][lab[1]+"->"+(phase or "unknown")]+=1
            if lab[2] in ("showery","non_showery","thunder"):
                character[model][lab[2]+"->"+(char or "unknown")]+=1
    return {"phase_confusion":{k:dict(v) for k,v in by.items()},
            "character_confusion":{k:dict(v) for k,v in character.items()}}

def train(rows):
    all_hours=sorted({t for t,_,_,_ in rows})
    if len(all_hours)<2:return {"active":False,"reason":"insufficient_cases","cases":len(rows)}
    cut=all_hours[max(1,min(len(all_hours)-1,int(len(all_hours)*.8)))]
    # Embargo 24 h: no same-day near-boundary cases in both sets.
    tr=[r for r in rows if r[0]<cut-timedelta(days=1)]
    va=[r for r in rows if r[0]>=cut]
    weights,stats=fit_factors(tr)
    base=metrics(va,{},.5,amount=True)
    vote=metrics(va,{},.5)
    scored=[(metrics(tr,weights,q)["csi"] or 0,q) for q in THRESHOLDS]
    threshold=max(scored,key=lambda v:(v[0],-abs(v[1]-.5)))[1]
    candidate=metrics(va,weights,threshold)
    enough=(len({t.date() for t,_,_,_ in tr})>=30 and len({t.date() for t,_,_,_ in va})>=14
            and sum(l[0] for _,_,l,_ in tr)>=60 and sum(l[0] for _,_,l,_ in va)>=30
            and sum(not l[0] for _,_,l,_ in va)>=30 and len(weights)>=3)
    # Fixed holdout needs to improve both baselines without trading away detection.
    csi=candidate["csi"];pod=candidate["pod"];far=candidate["far"]
    qualifies=bool(enough and None not in (csi,pod,far,base["csi"],vote["csi"],base["pod"],base["far"],candidate["brier"],vote["brier"])
        and csi>=max(base["csi"],vote["csi"])+.02 and pod>=base["pod"]-.03
        and far<=base["far"] and candidate["brier"]<=vote["brier"])
    return {"active":False,"shadow_qualified":qualifies,"reason":"manual_review_required" if qualifies else "holdout_gate_not_met",
            "cutoff":mv.iso(cut),"train_cases":len(tr),"holdout_cases":len(va),"candidate_threshold":threshold,
            "candidate_factors":weights,"train_model_metrics":stats,"baseline_amount":base,"baseline_vote":vote,"candidate":candidate,
            "holdout_types":phase_audit(va)}

def main():
    now=mv.utcnow()
    labels,secondary=hour_labels(mv.all_jsonl(mv.METAR_DIR)+mv.all_jsonl(mv.SPECI_DIR),mv.all_jsonl(mv.SYNOP_DIR),now)
    forecasts=mv.load_forecasts()
    rows=cases(forecasts,labels,now)
    sec=cases(forecasts,secondary,now)
    output={"schema":"prognozaepir-precipitation-learning-v1","station":"EPIR","generated_at":mv.iso(now),
            "mode":"shadow_only","active":False,
            "observations":{"wet_metar_hours":sum(v[0] for v in labels.values()),"dry_metar_hours":sum(not v[0] for v in labels.values()),"synop_positive_hours":len(secondary)},
            "amount":{"active":False,"reason":"no_verified_hourly_gauge_series","note":"METAR/SYNOP weather occurrence is not a measured hourly accumulation"},
            "learned_buckets":{b:train([r for r in rows if r[1]==b]) for _,_,b,_ in mv.LEAD_BUCKETS},
            "synop_positive_only":{"cases":len(sec),"type_audit":phase_audit(sec),
                "note":"Separate station, positive-only audit; never populates local dry labels or training."}}
    OUT.parent.mkdir(parents=True,exist_ok=True)
    tmp=OUT.with_suffix(".tmp");tmp.write_text(json.dumps(output,ensure_ascii=False,indent=2,allow_nan=False)+"\n",encoding="utf-8");tmp.replace(OUT)
    print("Precipitation shadow learning:",json.dumps({"observations":output["observations"],"buckets":{k:{i:v.get(i) for i in ("train_cases","holdout_cases","shadow_qualified")} for k,v in output["learned_buckets"].items()}},ensure_ascii=False))

if __name__=="__main__":
    main()
