#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path
from datetime import datetime, timezone, timedelta
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import build_precipitation_learning as p
import model_verification as mv

T=datetime(2026,11,22,12,tzinfo=timezone.utc)
def obs(raw,t=T):
    return {"station":"EPIR","raw":"EPIR 221200Z "+raw,"obs_time":mv.iso(t)}
class TestPrecip(unittest.TestCase):
    def test_metar(self):
        self.assertEqual(p.metar_label(obs("AUTO 25010KT 5000 -SHRA BKN010 05/04 Q1000")),(True,"rain","showery"))
        self.assertEqual(p.metar_label(obs("AUTO 25010KT 5000 -FZRA BKN010 00/M01 Q1000")),(True,"freezing","unknown"))
        self.assertEqual(p.metar_label(obs("AUTO 25010KT 5000 UP BKN010 00/M01 Q1000"))[1],"unknown")
        self.assertEqual(p.metar_label(obs("25010KT 5000 TSGR BKN010 05/04 Q1000")),(True,"hail","thunder"))
        self.assertEqual(p.metar_label(obs("25010KT 5000 SHGS BKN010 05/04 Q1000"))[1],"hail_or_pellets")
        self.assertEqual(p.metar_label(obs("25010KT 5000 SHRASN BKN010 01/00 Q1000"))[1],"mixed")
        self.assertIsNone(p.metar_label(obs("AUTO 25010KT 9999 FEW010 05/04 Q1000")))
        self.assertIsNone(p.metar_label(obs("25010KT 9999 FEW010 05/04 Q1000 RERA")))
        self.assertEqual(p.metar_label(obs("25010KT CAVOK 05/04 Q1000")),(False,None,None))
    def test_synop(self):
        def row(ix,ww):return {"raw":f"AAXX 22121 12342 0{ix}123 12345 7{ww:02d}00","present_weather_code":ww}
        self.assertIsNone(p.synop_label(row(7,61)))
        self.assertIsNone(p.synop_label(row(1,17)))
        self.assertEqual(p.synop_label(row(1,83)),(True,"mixed","showery"))
        self.assertEqual(p.synop_label(row(1,20)),(True,"unknown","unknown"))
    def test_hour_and_leakage(self):
        dry="25010KT CAVOK 05/04 Q1000"
        wet="AUTO 25010KT 5000 -SHRA BKN010 05/04 Q1000"
        labels,_=p.hour_labels([obs(wet,T-timedelta(minutes=30)),obs(dry)],[],T)
        self.assertEqual(labels[T],(True,"unknown","unknown","EPIR_METAR"))
        labels,_=p.hour_labels([obs(dry,T-timedelta(minutes=30)),obs(dry)],[],T)
        self.assertFalse(labels[T][0])
        labels,_=p.hour_labels([obs(dry,T-timedelta(minutes=30)),obs("AUTO "+dry)],[],T)
        self.assertNotIn(T,labels)
        labels,_=p.hour_labels([obs(wet)],[],T)
        self.assertEqual(labels[T][1],"rain")
        def fc(model,lead):
            return {"model":model,"valid_time":mv.iso(T),"run_time":mv.iso(T-timedelta(hours=lead)),"precipitation_mm":1,"weather_code":80}
        models=list(mv.MODEL_META)[:3]
        self.assertFalse(p.cases([fc(m,.5) for m in models],labels,T))
        self.assertEqual(len(p.cases([fc(m,2) for m in models],labels,T)),1)
    def test_metrics_and_guard(self):
        m=p.counts([(True,True),(False,True),(True,False),(False,False)])
        self.assertEqual(m["csi"],.33333)
        self.assertEqual(m["pod"],.5)
        self.assertEqual(m["far"],.5)
        self.assertFalse(p.train([])["active"])
        models={k:{"precipitation_mm":1,"weather_code":80} for k in list(mv.MODEL_META)[:3]}
        rows=[(T+timedelta(days=i),"0-3h",(True,"rain","showery","EPIR_METAR"),models) for i in range(10)]
        fit=p.train(rows)
        self.assertFalse(fit["active"])
        self.assertFalse(fit["shadow_qualified"])
        self.assertEqual(p.phase_audit(rows)["phase_confusion"][next(iter(models))]["rain->rain"],10)
    def test_gauge_guard(self):
        self.assertEqual(p.gauge_learning([],[],T)["reason"],"no_verified_hourly_gauge_series")
        row={"schema":"prognozaepir-hourly-gauge-v1","station":"EPIR","measurement":"gauge","quality":"verified","unit":"mm","duration_minutes":60,"source":"test gauge","valid_time":mv.iso(T),"precipitation_mm":1.0}
        self.assertEqual(p.gauge_learning([],[row],T)["n"],1)
        self.assertEqual(p.gauge_learning([],[{**row,"duration_minutes":360}],T)["n"],0)
        self.assertEqual(p.gauge_learning([],[row,{**row,"precipitation_mm":2}],T)["n"],0)
    def test_no_phase_guess(self):
        self.assertEqual(p.forecast_phase({"weather_code":95}),(None,"thunder"))
        self.assertEqual(p.forecast_phase({"weather_code":96}),("hail","thunder"))
        self.assertEqual(p.forecast_phase({"weather_code":61.5}),(None,None))
if __name__=="__main__":
    unittest.main()
