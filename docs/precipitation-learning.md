# Precipitation learning — EPIR (shadow)

## Objective
Separate events, phase, character and measured amount. The existing score conflates dry and wet cases; historical scores are diagnostic, not a production correction.

## Reference rules
- Model accumulation at T covers the preceding hour. Train only on forecasts archived no later than T−1h; use one forecast per model, target valid hour and lead bucket, with at least three models.
- EPIR METAR/SPECI: explicit local precipitation is positive; missing weather in AUTO is unknown, not a negative. No recent/nearby weather group is used as current weather. Dry labels require two valid manual reports covering the latter half of the hourly interval. Hourly occurrence remains observation-sampled, not a gauge truth.
- Instantaneous phase and character: observed at most five minutes before T, verified separately. UP and conflicting classifications remain unknown. GS and GR are not conflated.
- SYNOP 12342 manual WMO 4677 explicit wet observations constitute a separate positive-only audit. They do not replace local METAR truth. Do not interpret automatic code table 4680 as 4677.
- Intensity: optional data/learning/precipitation-gauge-hours.jsonl, with schema prognozaepir-hourly-gauge-v1, station EPIR, measurement gauge, quality verified, unit mm, duration_minutes 60, source, valid_time UTC at the interval end, precipitation_mm. Conflicting totals excluded; absence does not mean zero.

## Learning
Lead buckets and observation-hour grouping prevent duplicate forecast releases from inflating the sample count. Chronological 80/20 split with a 24-hour embargo. Occurrence candidate learns conservative weights from balanced accuracy and occurrence threshold from train CSI. Holdout compares against both base-weighted amount and base-weighted model wet fraction; evaluates CSI, POD, FAR, bias and Brier score. This is not a replay of historical adaptive consensus.
Phase/character use separate conditional one-vs-rest learning, minimum positive and negative samples, limited factors and held-out metrics. Rare events without coverage do not qualify. Measured hourly totals use MAE, RMSE, wet MAE and bias with bounded multiplier.
All outputs are shadow-only, even if qualification gates pass. Publication does not activate correction or change the meteogram. A later reviewed rollout should compare the candidate against archived actual runtime baseline and independent future cases.

## Execution
python3 tests/test_precipitation_learning.py
python3 scripts/build_precipitation_learning.py

The workflow runs at 04:43 UTC daily, on relevant PRs, on changes to main and manually. It uploads the report and publishes only data/learning/precipitation-learning.json on main. If gauge data are absent, amount learning stays inactive.


## Empirical archive audit — 2026-11-22 UTC

The first successful historical workflow used 648 labelled EPIR wet hours and 5,796 labelled dry hours (separately 2,328 SYNOP positive hours from station 12342). These are label-hour counts, not independent forecast events. Time-bucket training/holdout cases are much fewer.

Top **training** scores by occurrence CSI/FAR, used as candidates rather than final rankings:

| Lead | Model | Training CSI | Training FAR | Note |
| --- | --- | ---: | ---: | --- |
| 0–3 h | ICON-D2 | 0.537 | 0.326 | 40 positives in this model's training sample |
| 3–6 h | ICON-EU | 0.489 | 0.411 | 58 positives |
| 6–12 h | ICON-D2 | 0.408 | 0.375 | 37 positives |
| 12–24 h | ECMWF IFS | 0.500 | 0.400 | 40 positives |
| 24–48 h | ECMWF IFS | 0.355 | 0.582 | AIFS has very high POD but FAR 0.728 |
| 48–120 h | ALADIN 2 km | 0.292 | 0.533 | Only 32 positives; low-coverage candidate |

Rain-specific phase: for 24–48 h, training balanced accuracy ranked ICON-EU 0.684, ICON Global 0.659, ICON-D2 0.633. These comparisons used about 61 rain-positive and 18 rain-negative cases per model, not enough to fit class-specific correction under the present minimum-negative-sample gate. On the later holdout, ICON-D2 had 0.714 CSI, but only 12 observed rain-positive samples; selection based on this holdout would be leakage. There were **no sufficiently evidenced snow, hail, mixed-phase or thunderstorm class rankings** in the first run.

Occurrence holdout CSI 24–48 h improved from 0.261 (base amount) to 0.368 (candidate) and FAR from 0.657 to 0.517, but candidate Brier rose from 0.06293 to 0.06318. **All six occurrence buckets failed at least one holdout gate**, and no weather-type candidate qualified. Do not activate factors from this single run.

The meteogram's precipitation classifier now votes by **hydrometeor phase first**, e.g. RA and SHRA both support rain phase. A separate vote evaluates the steady/showery/thunder character. If phase is unresolved, report VAR; RA and SN in different models must never be converted to RASN. If phase is clear but character is uncertain, report that explicitly. WMO code splitting alone no longer creates spurious ambiguity. This deterministic presentation change is **not** an empirical model-weight calibration.

### Production promotion criteria
Any future phase or occurrence correction requires enough positive and negative events, strictly historical issue times, temporal holdout improvement, accepted reliability metrics, no worsening of rare-event false alarms, and an explicit reviewed activation. The runtime consumes class-specific factors only if report mode is production, the overall report and lead bucket are active and shadow-qualified, and the specific class is individually active and shadow-qualified. Generated reports never set those flags.
