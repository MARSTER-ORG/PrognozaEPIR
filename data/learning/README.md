# PrognozaEPIR Cloud Learning v1

Cloud Learning archives model cloud forecasts and verifies them against later EPIR METAR cloud observations.

Files:
- `forecasts/YYYY-MM-DD.jsonl` — archived model forecasts with run time, valid time and lead time.
- `verification/YYYY-MM-DD.jsonl` — matched forecast/METAR verification rows.
- `cloud-skill.json` — conservative lead-time-aware model skill and weight factors consumed by the web app.

METAR cloud amount is treated as an interval, not an exact okta value: FEW=1–2/8, SCT=3–4/8, BKN=5–7/8, OVC=8/8. Weight adaptation starts after 12 matched samples and reaches full influence at 60 samples. Factors are clamped to 0.55–1.80 so learning cannot dominate the consensus after a short or anomalous sample.
