-- Mirror of production Supabase migration 20261022131303_taf_vercel_backup_cron_20261022.
-- Railway-independent TAF fallback: fetch Vercel proxy; accept validated current
-- reports only; deduplicate into canonical messages with source attribution.
CREATE SCHEMA IF NOT EXISTS epir_internal;
REVOKE ALL ON SCHEMA epir_internal FROM PUBLIC;
CREATE TABLE IF NOT EXISTS epir_internal.taf_backup_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL,
  epir_available boolean NOT NULL DEFAULT false,
  available_stations integer NOT NULL DEFAULT 0,
  inserted integer NOT NULL DEFAULT 0,
  rejected integer NOT NULL DEFAULT 0,
  diagnostic text
);
REVOKE ALL ON epir_internal.taf_backup_runs FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION epir_internal.fetch_taf_backup()
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_http_status integer;
  v_http_body text;
  v_json jsonb;
  v_station text;
  v_item jsonb;
  v_source text;
  v_source_ref text;
  v_raw text;
  v_issue timestamptz;
  v_start timestamptz;
  v_end timestamptz;
  v_hash text;
  v_result jsonb;
  v_inserted integer := 0;
  v_available integer := 0;
  v_rejected integer := 0;
  v_epir_available boolean := false;
  v_err text;
  v_status text;
BEGIN
  PERFORM extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS', '18000');
  SELECT r.status, r.content INTO v_http_status, v_http_body
  FROM extensions.http_get('https://prognozaepir-taf-proxy.vercel.app/api/taf-proxy') AS r;

  IF v_http_status IS DISTINCT FROM 200 OR v_http_body IS NULL THEN
    RAISE EXCEPTION 'Vercel backup HTTP status: %', v_http_status;
  END IF;

  v_json := v_http_body::jsonb;
  IF v_json->>'schema' <> 'prognozaepir-taf-proxy-v2'
     OR jsonb_typeof(v_json->'stations') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Unexpected TAF proxy response schema';
  END IF;

  v_epir_available := coalesce((v_json #>> '{stations,EPIR,available}')::boolean,false)
     AND coalesce((v_json #>> '{stations,EPIR,current}')::boolean,false);

  FOREACH v_station IN ARRAY ARRAY['EPIR','EPBY','EPPW','EPKS']::text[] LOOP
    v_item := v_json->'stations'->v_station;
    IF v_item IS NULL
       OR NOT coalesce((v_item->>'available')::boolean,false)
       OR NOT coalesce((v_item->>'current')::boolean,false)
       OR coalesce((v_item->>'stale')::boolean,false)
       OR coalesce((v_item->>'nil')::boolean,false)
       OR coalesce((v_item->>'cancelled')::boolean,false) THEN
      CONTINUE;
    END IF;

    v_available := v_available + 1;
    BEGIN
      v_source := upper(btrim(coalesce(v_item->>'source','')));
      IF v_source NOT IN ('IMGW','PILOTHUB','AWC') THEN
        v_rejected := v_rejected + 1;
        CONTINUE;
      END IF;

      v_raw := regexp_replace(upper(btrim(coalesce(v_item->>'raw',''))), '[[:space:]]+', ' ', 'g');
      v_issue := (v_item->>'issue_iso')::timestamptz;
      v_start := (v_item->>'valid_start')::timestamptz;
      v_end := (v_item->>'valid_end')::timestamptz;

      IF v_raw IS NULL OR length(v_raw) NOT BETWEEN 30 AND 1900
         OR right(v_raw,1) <> '='
         OR v_issue IS NULL OR v_start IS NULL OR v_end IS NULL
         OR v_issue < clock_timestamp()-interval '30 hours'
         OR v_issue > clock_timestamp()+interval '15 minutes'
         OR v_end <= v_start
         OR v_start < v_issue-interval '8 hours'
         OR v_start > v_issue+interval '30 hours'
         OR v_end > v_issue+interval '72 hours'
         OR v_end-v_start > interval '48 hours'
         OR v_raw !~ ('^TAF( AMD| COR)? ' || v_station || ' ' ||
                      to_char(v_issue AT TIME ZONE 'UTC','DDHH24MI') || 'Z ') THEN
        v_rejected := v_rejected + 1;
        CONTINUE;
      END IF;

      v_hash := encode(extensions.digest(v_raw,'sha256'),'hex');
      IF EXISTS (
        SELECT 1 FROM public.messages
        WHERE message_type='TAF' AND station_code=v_station
          AND archive_time=v_issue AND content_hash=v_hash
      ) THEN
        CONTINUE;
      END IF;

      v_source_ref := coalesce(v_item->>'source_url','');
      IF v_source_ref !~ '^https://(aviation-api\.imgw\.pl|awiacja\.imgw\.pl|aviationweather\.gov|pilothub\.(pl|sk))(/|$)' THEN
        v_source_ref := 'https://prognozaepir-taf-proxy.vercel.app/api/taf-proxy';
      END IF;

      SELECT public.ingest_message_batch(jsonb_build_array(jsonb_build_object(
        'message_type','TAF',
        'station_code',v_station,
        'issued_at',v_issue,
        'archive_time',v_issue,
        'valid_from',v_start,
        'valid_to',v_end,
        'raw_text',v_raw,
        'normalized_text',v_raw,
        'content_hash',v_hash,
        'source_ref',v_source_ref,
        'payload',jsonb_build_object(
           'schema','prognozaepir-message-v1',
           'type','TAF','station',v_station,'raw',v_raw,
           'canonical_raw',v_raw,
           'source',v_source,
           'source_ref',v_source_ref,
           'source_note','Automatic Vercel fallback (independent of Railway)',
           'issue_time',to_char(v_issue AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'valid_from',to_char(v_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'),
           'valid_to',to_char(v_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')
        ),
        'weather_codes',jsonb_build_array()
      ))) INTO v_result;

      v_inserted := v_inserted + coalesce((v_result->>'inserted')::integer,0);
    EXCEPTION WHEN OTHERS THEN
      v_rejected := v_rejected+1;
      v_err := left(coalesce(v_err || '; ','') || v_station || ': ' || SQLERRM,400);
      RAISE WARNING 'TAF fallback rejected %: %',v_station,SQLERRM;
    END;
  END LOOP;

  v_status := CASE WHEN v_epir_available THEN 'epir_source_available'
                   ELSE 'epir_source_unavailable' END;
  INSERT INTO epir_internal.taf_backup_runs
    (status,epir_available,available_stations,inserted,rejected,diagnostic)
  VALUES (v_status,v_epir_available,v_available,v_inserted,v_rejected,v_err);

  RETURN jsonb_build_object(
    'ok',true,'status',v_status,'epir_available',v_epir_available,
    'available_stations',v_available,'inserted',v_inserted,'rejected',v_rejected,
    'diagnostic',v_err
  );
EXCEPTION WHEN OTHERS THEN
  v_err := left(SQLSTATE || ': ' || SQLERRM,400);
  INSERT INTO epir_internal.taf_backup_runs (status,diagnostic)
  VALUES ('source_error',v_err);
  RAISE WARNING 'TAF Vercel fallback failed: %',v_err;
  RETURN jsonb_build_object('ok',false,'status','source_error','diagnostic',v_err);
END
$function$

REVOKE ALL ON FUNCTION epir_internal.fetch_taf_backup() FROM PUBLIC, anon, authenticated;
SELECT cron.schedule('prognozaepir-taf-vercel-fallback', '*/20 * * * *',
  $job$SELECT epir_internal.fetch_taf_backup();$job$);
