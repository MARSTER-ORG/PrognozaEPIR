-- PrognozaEPIR / Fog Engine vNext
-- Reproducible inventory of the historical observation archive.
-- Read-only: this script does not modify public.messages.
-- Target pairing for EPIR fog work:
--   aviation: METAR/SPECI station EPIR
--   auxiliary historical SYNOP: station 12342
-- Event definition used here: consecutive FG/MIFG/BR observations belong to
-- the same event when the gap between fog-family observations is <= 3 hours.

-- 1. Archive coverage by message type.
SELECT
  message_type,
  count(*) AS rows,
  min(coalesce(observed_at, issued_at, archive_time)) AS first_time,
  max(coalesce(observed_at, issued_at, archive_time)) AS last_time,
  count(DISTINCT station_code) AS stations,
  sum(duplicate_count) AS duplicate_seen_total
FROM public.messages
WHERE message_type IN ('METAR','SPECI','SYNOP')
GROUP BY message_type
ORDER BY message_type;

-- 2. Station/type inventory and direct fog-family labels.
SELECT
  message_type,
  station_code,
  count(*) AS rows,
  min(coalesce(observed_at, issued_at, archive_time)) AS first_time,
  max(coalesce(observed_at, issued_at, archive_time)) AS last_time,
  sum(CASE WHEN has_fg THEN 1 ELSE 0 END) AS fg_rows,
  sum(CASE WHEN has_mifg THEN 1 ELSE 0 END) AS mifg_rows,
  sum(CASE WHEN has_br THEN 1 ELSE 0 END) AS br_rows
FROM public.messages
WHERE message_type IN ('METAR','SPECI','SYNOP')
GROUP BY message_type, station_code
ORDER BY message_type, rows DESC;

-- 3. EPIR target inventory and visibility thresholds.
SELECT
  count(*) AS aviation_rows,
  count(*) FILTER (
    WHERE coalesce(has_fg,false)
       OR coalesce(has_mifg,false)
       OR coalesce(has_br,false)
  ) AS fog_family_rows,
  count(*) FILTER (WHERE has_fg) AS fg_rows,
  count(*) FILTER (WHERE has_mifg) AS mifg_rows,
  count(*) FILTER (WHERE has_br) AS br_rows,
  count(*) FILTER (WHERE visibility_m < 1000) AS vis_lt_1000,
  count(*) FILTER (WHERE visibility_m <= 500) AS vis_le_500,
  count(*) FILTER (WHERE visibility_m <= 200) AS vis_le_200,
  count(*) FILTER (WHERE visibility_m IS NULL) AS vis_missing
FROM public.messages
WHERE station_code='EPIR'
  AND message_type IN ('METAR','SPECI');

-- 4. Exact duplicate check for the target archive.
WITH x AS (
  SELECT
    message_type,
    station_code,
    coalesce(observed_at, issued_at, archive_time) AS t,
    content_hash
  FROM public.messages
  WHERE (message_type IN ('METAR','SPECI') AND station_code='EPIR')
     OR (message_type='SYNOP' AND station_code='12342')
), g AS (
  SELECT message_type, station_code, t, content_hash, count(*) AS n
  FROM x
  GROUP BY message_type, station_code, t, content_hash
  HAVING count(*) > 1
)
SELECT
  count(*) AS duplicate_groups,
  coalesce(sum(n-1),0) AS duplicate_extra_rows
FROM g;

-- 5. EPIR METAR cadence and long gaps. SPECI is intentionally excluded
-- because it is event-driven and has no regular cadence.
WITH x AS (
  SELECT coalesce(observed_at, issued_at, archive_time) AS t
  FROM public.messages
  WHERE station_code='EPIR' AND message_type='METAR'
), d AS (
  SELECT t, t-lag(t) OVER (ORDER BY t) AS gap
  FROM x
)
SELECT
  count(*) FILTER (WHERE gap > interval '60 minutes') AS gaps_gt_60m,
  count(*) FILTER (WHERE gap > interval '90 minutes') AS gaps_gt_90m,
  count(*) FILTER (WHERE gap > interval '3 hours') AS gaps_gt_3h,
  count(*) FILTER (WHERE gap > interval '12 hours') AS gaps_gt_12h,
  round(max(extract(epoch FROM gap)/3600)::numeric,2) AS max_gap_h,
  percentile_cont(0.5) WITHIN GROUP (
    ORDER BY extract(epoch FROM gap)/60
  ) AS median_gap_min
FROM d
WHERE gap IS NOT NULL;

-- 6. Daily METAR coverage by month. A near-full day has >=40 METARs;
-- nominal 30-minute coverage is ~48/day.
WITH x AS (
  SELECT
    (coalesce(observed_at, issued_at, archive_time) AT TIME ZONE 'UTC')::date AS d,
    count(*) AS n
  FROM public.messages
  WHERE station_code='EPIR' AND message_type='METAR'
  GROUP BY 1
), bounds AS (
  SELECT min(d) AS lo, max(d) AS hi FROM x
), cal AS (
  SELECT generate_series(lo,hi,interval '1 day')::date AS d FROM bounds
), y AS (
  SELECT cal.d, coalesce(x.n,0) AS n
  FROM cal LEFT JOIN x USING(d)
)
SELECT
  to_char(date_trunc('month',d),'YYYY-MM') AS ym,
  count(*) AS day_count,
  count(*) FILTER (WHERE n=0) AS zero_days,
  count(*) FILTER (WHERE n BETWEEN 1 AND 19) AS low_days,
  count(*) FILTER (WHERE n BETWEEN 20 AND 39) AS partial_days,
  count(*) FILTER (WHERE n>=40) AS near_full_days,
  round(avg(n)::numeric,1) AS avg_per_day
FROM y
GROUP BY date_trunc('month',d)
ORDER BY date_trunc('month',d);

-- 7. Distinct EPIR fog-family events.
WITH obs AS (
  SELECT
    id,
    coalesce(observed_at,issued_at,archive_time) AS t,
    has_fg,has_mifg,has_br,
    visibility_m
  FROM public.messages
  WHERE station_code='EPIR'
    AND message_type IN ('METAR','SPECI')
), active AS (
  SELECT *, lag(t) OVER(ORDER BY t,id) AS prev_t
  FROM obs
  WHERE coalesce(has_fg,false)
     OR coalesce(has_mifg,false)
     OR coalesce(has_br,false)
), marked AS (
  SELECT *, CASE
    WHEN prev_t IS NULL OR t-prev_t>interval '3 hours' THEN 1 ELSE 0
  END AS new_event
  FROM active
), numbered AS (
  SELECT *, sum(new_event) OVER(ORDER BY t,id) AS event_id
  FROM marked
), events AS (
  SELECT
    event_id,
    min(t) AS start_t,
    max(t) AS end_t,
    count(*) AS obs_count,
    bool_or(has_fg) AS has_fg,
    bool_or(has_mifg) AS has_mifg,
    bool_or(has_br) AS has_br,
    min(visibility_m) AS min_vis
  FROM numbered
  GROUP BY event_id
)
SELECT
  count(*) AS event_count,
  count(*) FILTER(WHERE has_fg) AS events_with_fg,
  count(*) FILTER(WHERE has_mifg) AS events_with_mifg,
  count(*) FILTER(WHERE has_br) AS events_with_br,
  count(*) FILTER(WHERE has_fg AND has_br) AS events_fg_br,
  count(*) FILTER(WHERE has_fg AND has_mifg) AS events_fg_mifg,
  min(start_t) AS first_event,
  max(end_t) AS last_event,
  round(avg(extract(epoch FROM (end_t-start_t))/3600)::numeric,2) AS avg_span_h,
  round(percentile_cont(0.5) WITHIN GROUP(
    ORDER BY extract(epoch FROM (end_t-start_t))/3600
  )::numeric,2) AS median_span_h,
  max(extract(epoch FROM (end_t-start_t))/3600) AS max_span_h
FROM events;

-- 8. Seasonal distribution of event starts.
WITH obs AS (
  SELECT id,coalesce(observed_at,issued_at,archive_time) AS t,
         has_fg,has_mifg,has_br
  FROM public.messages
  WHERE station_code='EPIR' AND message_type IN ('METAR','SPECI')
), active AS (
  SELECT *,lag(t) OVER(ORDER BY t,id) AS prev_t
  FROM obs
  WHERE coalesce(has_fg,false)
     OR coalesce(has_mifg,false)
     OR coalesce(has_br,false)
), marked AS (
  SELECT *,CASE WHEN prev_t IS NULL OR t-prev_t>interval '3 hours'
                THEN 1 ELSE 0 END AS new_event
  FROM active
), numbered AS (
  SELECT *,sum(new_event) OVER(ORDER BY t,id) AS event_id FROM marked
), events AS (
  SELECT event_id,min(t) AS start_t,
         bool_or(has_fg) AS has_fg,
         bool_or(has_mifg) AS has_mifg,
         bool_or(has_br) AS has_br
  FROM numbered GROUP BY event_id
), s AS (
  SELECT *,CASE
    WHEN extract(month FROM start_t) IN (12,1,2) THEN 'DJF'
    WHEN extract(month FROM start_t) IN (3,4,5) THEN 'MAM'
    WHEN extract(month FROM start_t) IN (6,7,8) THEN 'JJA'
    ELSE 'SON' END AS season
  FROM events
)
SELECT
  season,
  count(*) AS events,
  count(*) FILTER(WHERE has_fg) AS fg_events,
  count(*) FILTER(WHERE has_mifg) AS mifg_events,
  count(*) FILTER(WHERE has_br) AS br_events
FROM s
GROUP BY season
ORDER BY CASE season WHEN 'DJF' THEN 1 WHEN 'MAM' THEN 2
                     WHEN 'JJA' THEN 3 ELSE 4 END;

-- 9. Structured feature availability.
SELECT
  message_type,
  count(*) AS n,
  count(visibility_m) AS visibility,
  count(wind_speed_kt) AS wind_speed,
  count(wind_direction_deg) AS wind_direction,
  count(temperature_c) AS temperature,
  count(payload->>'dew_point_c') AS dew_point,
  count(payload->>'relative_humidity_pct') AS relative_humidity,
  count(qnh_hpa) AS qnh,
  count(ceiling_ft) AS ceiling,
  count(*) FILTER(WHERE payload ? 'clouds') AS clouds_key
FROM public.messages
WHERE (station_code='EPIR' AND message_type IN ('METAR','SPECI'))
   OR (station_code='12342' AND message_type='SYNOP')
GROUP BY message_type
ORDER BY message_type;

-- 10. Recoverability of 2025 METAR structured values from raw text.
-- This is diagnostic only; it does not alter the archive.
SELECT
  count(*) AS n,
  count(*) FILTER(WHERE upper(raw_text) ~
    '(^|[[:space:]])M?[0-9]{2}/M?[0-9]{2}([[:space:]]|=|$)') AS raw_temp_dew_token,
  count(*) FILTER(WHERE upper(raw_text) ~
    '(^|[[:space:]])(CAVOK|[0-9]{4})([[:space:]]|=|$)') AS raw_vis_token,
  count(*) FILTER(WHERE upper(raw_text) ~
    '(FEW|SCT|BKN|OVC|VV)[0-9/]{3}') AS raw_cloud_token,
  count(*) FILTER(WHERE
    upper(raw_text) ~ '(^|[[:space:]])[0-9]{3}[0-9]{2}(G[0-9]{2})?KT([[:space:]]|=|$)'
    OR upper(raw_text) ~ '(^|[[:space:]])VRB[0-9]{2}(G[0-9]{2})?KT([[:space:]]|=|$)'
  ) AS raw_wind_token
FROM public.messages
WHERE station_code='EPIR'
  AND message_type='METAR'
  AND coalesce(observed_at,issued_at,archive_time)<'2026-01-01';

-- 11. SYNOP teacher-field availability.
SELECT
  count(*) AS n,
  count(*) FILTER(WHERE payload->>'present_weather_code' IS NOT NULL)
    AS present_weather_code_n,
  count(*) FILTER(WHERE payload->>'present_weather' IS NOT NULL)
    AS present_weather_text_n,
  count(*) FILTER(WHERE payload->>'cloud_base_m_agl' IS NOT NULL)
    AS cloud_base_n,
  count(*) FILTER(WHERE payload->>'total_cloud_oktas' IS NOT NULL)
    AS cloud_oktas_n,
  count(*) FILTER(WHERE payload->>'dew_point_c' IS NOT NULL)
    AS dewpoint_n,
  count(*) FILTER(WHERE payload->>'relative_humidity_pct' IS NOT NULL)
    AS rh_n
FROM public.messages
WHERE station_code='12342' AND message_type='SYNOP';
