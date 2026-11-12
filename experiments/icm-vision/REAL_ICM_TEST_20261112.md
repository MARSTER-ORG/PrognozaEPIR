# Real ICM UM4 meteogram — one-shot Gemini Vision experiment (2026-11-12)

## Input
User-supplied screenshot, crop to meteorogram only. Inowrocław (52.80, 18.26), `UM4 60h`, axis `UTC+1`, dates Thu 12.11–Sat 14.11. Image sent once through the authenticated ICM Vision Edge Function, without requesting or scraping ICM's servers.

## Technical result: PASS
- Primary Gemini model `gemini-3.5-flash-lite`: `503 UNAVAILABLE` (temporary high demand).
- Fallback `gemini-3.1-flash-lite`: `HTTP 200` / `ok=true`.
- Result: 12 extracted rows in JSON, `timeBasis=LOCAL`, `issueUtc=null`, `timestampUtc=null` for every row.
- Visibility was not invented: `visibilityM=null`.
- No database writes. `consensusEnabled=false`, `tafEnabled=false`.

## Data quality: FAIL — do not enable the model as an NWP source
1. Model output axis labels were `08,11,14,17,20,23,02,05,08,11,14,17`, **three-hourly**, not hourly despite the requested hours.
2. `cloudCoverPct=0.8/0.9` was returned with **percentage units**, although the ICM chart displays cloud cover in **octas (0–8)** and a separate fog fraction (0–1). The output is unit-inconsistent.
3. `windSpeedMs` received numbers 6–9, but its evidence was generic ("Reading from n-th column") rather than pointing to average-wind versus gusts series. Cannot validate this as mean wind.
4. `confidence=high` and generic evidence appeared together, overclaiming reliability.
5. Numerical temperature error is visible. For 13.11 around **11:00 local (UTC+1)**, Gemini returned `temperatureC=2.5`, while the red temperature curve appears near **5–6°C** (approximate visual read, not a calibrated digitization).
6. No trustworthy UTC timestamps were produced, as the existing conservative parser does not convert local `UTC+1` axes to UTC without validated date context.

Example response: 12.11 08:00 local: T=2.0°C, Td=1.0°C, RH=95%; 13.11 11:00 local: T=2.5°C, Td=0.5°C, RH=80%. These are **AI outputs**, not verified ICM model truth.

## Isolation and safeguards
- Temporary one-off smoke function retired (`410` and `verify_jwt=true`).
- Temporary private Google Drive images created for transport were deleted after the test.
- Added deterministic `non_hourly_axis_step`, `cloud_cover_unit_not_pct`, `generic_evidence`, and `wind_series_not_identified` gates.
- A synthetic replay against the updated core yielded **9/9 checks PASS**, but **no new real-image AI run after the gate/prompt changes** has been performed.
- Automatic ICM downloads remain DISABLED pending access conditions.

## Recommendation
Keep `icm-vision-probe` exploratory only. Next evaluate time-axis reconstruction from date + UTC offset and perform reference-based temperature digitization; verify the 12–24h time series at 1-hour resolution and parameter-specific evidence before deciding whether this can feed Consensus.
