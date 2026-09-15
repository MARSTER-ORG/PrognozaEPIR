# Fog Engine vNext — inventory of the historical archive

Snapshot: **2026-09-15**  
Primary target: **EPIR**  
Auxiliary SYNOP station: **12342**  
Source of counts: `public.messages` in the PrognozaEPIR Supabase archive.

This is the Sprint 0 baseline for the next Fog Engine. The source archive was not modified.
The queries used to reproduce the inventory are in `scripts/fog_archive_inventory.sql`.

## 1. Archive size and date range

| Type | Rows | First | Last | Stations |
|---|---:|---|---|---:|
| METAR | 21,432 | 2025-01-01 00:00Z | 2026-09-15 15:30Z | 5 |
| SPECI | 160 | 2025-01-07 18:37Z | 2026-09-15 08:12Z | 3 |
| SYNOP | 10,576 | 2025-01-01 00:00Z | 2026-09-10 19:00Z | 1 |

For the EPIR training target itself there are **21,013 METAR + 154 SPECI = 21,167 aviation observations**.
The associated historical SYNOP archive for station 12342 contains **10,576 observations**.

No exact duplicate groups were found for EPIR METAR/SPECI + 12342 SYNOP using
`message_type + station + observation time + content_hash`.

## 2. Fog/mist labels at EPIR

Combined EPIR METAR/SPECI:

| Label / threshold | Observations |
|---|---:|
| FG | 598 |
| MIFG | 106 |
| BR | 1,400 |
| Union FG/MIFG/BR | 2,089 |
| visibility < 1000 m | 608 |
| visibility <= 500 m | 383 |
| visibility <= 200 m | 206 |
| visibility missing in structured column | 1,316 |

The union is smaller than the sum of the individual labels because some observations contain more than one relevant flag.

## 3. Distinct fog-family events

For the initial inventory, an event is a sequence of observations containing at least one of
`FG`, `MIFG`, or `BR`; a new event starts when the gap to the previous fog-family observation is greater than **3 h**.
This definition is intentionally simple and deterministic. It will be replaced by the phase-aware event extractor in the training dataset builder.

Result:

- **168 distinct fog-family events**,
- **58** events containing FG,
- **32** events containing MIFG,
- **146** events containing BR,
- first event: **2025-01-09 06:00Z**,
- last event in this snapshot: **2026-09-14 07:00Z**,
- median event span: **2.50 h**,
- mean event span: **6.19 h**,
- maximum span: **56.5 h**.

Year split:

| Year | Events | with FG | with MIFG | with BR |
|---|---:|---:|---:|---:|
| 2025 | 82 | 30 | 13 | 72 |
| 2026 (to 15 Sep) | 86 | 28 | 19 | 74 |

Season of event onset:

| Season | Events | with FG | with MIFG | with BR |
|---|---:|---:|---:|---:|
| DJF | 68 | 24 | 1 | 67 |
| MAM | 38 | 13 | 11 | 32 |
| JJA | 33 | 9 | 12 | 22 |
| SON | 29 | 12 | 8 | 25 |

This is enough positive-event material for a first interpretable statistical/tree baseline,
but it is not a large dataset by modern deep-learning standards. Validation must therefore be chronological and event-based rather than random row splitting.

## 4. Archive continuity — important training caveat

The median interval between EPIR METAR reports is **30 min**, but the historical archive is not uniformly complete.
Across the 623 calendar days covered by EPIR METAR:

- 332 days have >=40 METARs (near-full daily coverage),
- 159 days have 20–39 reports,
- 14 days have 1–19 reports,
- 118 days contain no EPIR METAR,
- average: 33.73 METAR/day.

Long-gap inventory:

- 190 gaps >60 min,
- 185 gaps >90 min,
- 179 gaps >3 h,
- 76 gaps >12 h,
- longest gap: **134.5 h**.

The biggest sampling-regime change is visible in 2025 vs 2026. From **April 2026 onward**, coverage is essentially continuous at about 48 reports/day, apart from isolated days. Much of March–December 2025 is partial or contains entire missing days.

**Training rule:** a missing observation must never be interpreted as `CLEAR`. Negative examples are allowed only inside periods with verified observation coverage. Event detection must also carry a data-gap flag so that onset/dissipation times are not fabricated across missing periods.

## 5. Structured-feature completeness

### EPIR METAR

Out of 21,013 rows:

- visibility: 19,697 (**93.7%**),
- wind speed: 21,012 (**~100%**),
- temperature: 11,620 (**55.3%**),
- dew point: 11,620 (**55.3%**),
- QNH: 20,992,
- structured ceiling: 6,987.

The low temperature/dew-point percentage is a normalization issue, not evidence that the historical reports lack T/Td. The entire 2025 METAR block comes from the older DOCX import and its raw text was retained without the later structured parsing.

For the 9,393 EPIR METARs from 2025, raw-text recoverability is:

- T/Td token: **9,353 / 9,393 = 99.6%**,
- wind token: **9,391 / 9,393 = 99.98%**,
- standard visibility/CAVOK token: **8,077 / 9,393 = 86.0%**,
- FEW/SCT/BKN/OVC/VV token: **4,432 / 9,393 = 47.2%**.

Therefore **2025 must not be discarded**. The next dataset builder should normalize the retained raw METAR text and derive T, Td, spread, RH, visibility bounds, wind and cloud-base features into a separate training record.

### EPIR SPECI

Out of 154 rows:

- visibility: 154 (100%),
- wind speed: 154 (100%),
- temperature/dew point structured fields: 30 (19.5%).

SPECI should remain exact-minute observations and should not be rounded into the regular METAR cadence.

### SYNOP 12342

Out of 10,576 rows:

- dew point: 5,727 (54.2%),
- RH: 5,726 (54.1%),
- cloud base: 5,634 (53.3%),
- total cloud amount: 5,635,
- parsed present-weather code: 1,700 (16.1%),
- parsed present-weather text: 637.

SYNOP is therefore useful as an **auxiliary historical teacher/context source**, but it must not be a mandatory operational input. Missing SYNOP fields must degrade gracefully.

## 6. Source generations in the archive

The target data come from several generations of collection/import:

- 2025 EPIR METAR: mainly `DOCX_ARCHIVE_2025` — 9,393 rows,
- early 2026 EPIR METAR: mainly `DOCX_ARCHIVE_2026` — 6,504 rows,
- Jun–Sep 2026 historical bulk METAR: `EPIR_BULK_ARCHIVE_METAR` — 4,732 rows,
- current live period adds IMGW/CZAD/PilotHub/manual sources,
- SYNOP similarly combines DOCX archives, bulk raw archive and manual backfill.

The training dataset therefore needs one canonical parser/normalizer independent of source generation. Source name must remain as a provenance field so that distribution shifts can be audited.

## 7. Decision for the first modelling stage

The archive is large enough to proceed, with two constraints that must be enforced in code:

1. **normalize historical raw observations before feature building**, especially 2025 METAR/SPECI;
2. **mask coverage gaps** so absence of data does not become a false negative.

The first model should be an interpretable baseline (logistic regression and/or gradient-boosted trees with probability calibration), evaluated against persistence, climatology and the current Fog Engine. Deep neural modelling is not justified by the current number of independent fog events.

The first targets should be separated:

- FG occurrence,
- MIFG occurrence,
- BR occurrence,
- visibility <1000 m,
- visibility <=500 m,
- visibility <=200 m,
- fog-family onset window,
- dissipation window.

The existing Fog Engine remains the `legacy_expert` baseline and is not removed during this work.

## 8. Next implementation unit

The next code unit is the **Fog Training Dataset Builder**:

`archive -> normalize -> coverage mask -> event phases -> features -> train/validation rows`

Required outputs:

- canonical observation JSONL/Parquet-equivalent training records,
- event table with `precondition / onset / mature / dissipation / post-event`,
- quality flags and source provenance,
- no-data masks,
- chronological train/validation partitions,
- baseline score report.

This inventory is the fixed reference against which that builder will be tested.
