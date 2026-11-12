# ICM Vision — real Gemini smoke test (2026-11-12)

## Scope
Actual end-to-end chain tested: Supabase authenticated `icm-vision-probe` → Gemini multimodal image analysis → JSON → normalization validator. The input was a **synthetic** PNG chart (NOT an ICM forecast), size 1251 bytes, with UTC axis and air-temperature/dew-point lines.

## Result: PASS
Gemini: `gemini-3.5-flash-lite`. Supabase function returned HTTP 200 `ok:true`.
- 12 UTC: T=1°C, Td=0°C (expected 1/0)
- 13 UTC: T=3°C, Td=1°C (expected 3/1)
- 14 UTC: T=5°C, Td=2°C (expected 5/2)
- 15 UTC: T=4°C, Td=2°C (expected 4/2)
- Exact matches: **8 of 8 numerical values**.
- `timeBasis=UTC`; all four timestamps correctly read as 2026-11-12T12/13/14/15:00:00Z.
- `flags=[]`; humidity, cloud cover, cloud base, wind, precipitation and visibility correctly null.
- `consensusEnabled=false`, `tafEnabled=false`, `stored=false`.

## Issues detected and fixed
1. Previous default `gemini-2.5-flash-lite` returned HTTP 404 under the current Gemini API project. Changed Edge Function and local runner to `gemini-3.5-flash-lite`.
2. First synthetic fixture copied into temporary diagnostic had a corrupt PNG palette; regenerated a valid 1251-byte PNG.
3. PostgreSQL `http` extension had a 5-second timeout, so the test call used a one-time 45-second timeout.

## Cleanup and limitations
Temporary public smoke-test endpoint `icm-vision-smoke-20261112` was replaced with a `410 diagnostic_retired` handler and `verify_jwt=true`.
The primary `icm-vision-probe` remains isolated, with `verify_jwt=true`, and has no cron or writes to production.
**Not tested:** automated acquisition of current ICM images, authorization against ICM API, and extraction accuracy from real complex ICM meteograms. ICM automated acquisition stays disabled until authorized access is configured.

Do not interpret this smoke test as model forecast skill or readiness for aviation use.
