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
