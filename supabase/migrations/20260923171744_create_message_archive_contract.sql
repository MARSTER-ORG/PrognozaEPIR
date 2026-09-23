-- Versioned contract for the MessageArchive tables used by the Railway mirror,
-- message-ingest, message-archive, server-side mirrors, and retention jobs.

create table if not exists public.message_sources (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  priority integer not null default 100,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint message_sources_code_chk check (code ~ '^[A-Z0-9_]{2,64}$'),
  constraint message_sources_name_chk check (btrim(name) <> '')
);

create table if not exists public.stations (
  id uuid primary key default gen_random_uuid(),
  icao text,
  name text not null,
  wmo text,
  latitude double precision,
  longitude double precision,
  elevation_m integer,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stations_code_present_chk check (icao is not null or wmo is not null),
  constraint stations_icao_chk check (icao is null or icao ~ '^[A-Z0-9]{4,5}$'),
  constraint stations_wmo_chk check (wmo is null or wmo ~ '^[0-9]{5}$'),
  constraint stations_latitude_chk check (latitude is null or latitude between -90 and 90),
  constraint stations_longitude_chk check (longitude is null or longitude between -180 and 180),
  constraint stations_name_chk check (btrim(name) <> '')
);

create unique index if not exists stations_icao_uidx
  on public.stations (icao) where icao is not null;
create unique index if not exists stations_wmo_uidx
  on public.stations (wmo) where wmo is not null;

insert into public.stations (icao, name)
select seed.icao, seed.name
from (values
  ('EPIR', 'Inowroclaw'),
  ('EPBY', 'Bydgoszcz'),
  ('EPKS', 'Poznan-Krzesiny'),
  ('EPPW', 'Powidz')
) as seed(icao, name)
where not exists (
  select 1
  from public.stations station
  where station.icao = seed.icao or station.wmo = seed.icao
);

-- Repair only the exact legacy seed shape when no canonical WMO row exists.
-- If production already has wmo=12342, leave every existing row untouched.
update public.stations legacy
set icao = null,
    wmo = '12342',
    updated_at = now()
where legacy.icao = '12342'
  and legacy.wmo is null
  and not exists (
    select 1
    from public.stations canonical
    where canonical.wmo = '12342'
  );

insert into public.stations (wmo, name)
select '12342', '12342'
where not exists (
  select 1
  from public.stations station
  where station.wmo = '12342' or station.icao = '12342'
);

create table if not exists public.messages (
  id bigint generated always as identity primary key,
  message_type text not null,
  station_id uuid references public.stations(id) on delete set null,
  station_code text not null,
  observed_at timestamptz,
  issued_at timestamptz,
  valid_from timestamptz,
  valid_to timestamptz,
  raw_text text not null,
  normalized_text text not null,
  source_id uuid references public.message_sources(id) on delete set null,
  source_ref text,
  ingested_at timestamptz not null default now(),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  duplicate_count bigint not null default 0,
  payload jsonb not null,
  content_hash text not null,
  archive_time timestamptz not null,
  visibility_m integer,
  wind_direction_deg integer,
  wind_speed_kt double precision,
  gust_kt double precision,
  temperature_c double precision,
  qnh_hpa double precision,
  ceiling_ft integer,
  weather_codes text[] not null default '{}',
  has_fg boolean not null default false,
  has_br boolean not null default false,
  has_mifg boolean not null default false,
  has_ts boolean not null default false,
  has_ra boolean not null default false,
  has_sn boolean not null default false,
  has_cb boolean not null default false,
  has_tcu boolean not null default false,
  has_vv boolean not null default false,
  constraint messages_type_chk check (message_type in ('METAR', 'SPECI', 'TAF', 'SYNOP')),
  constraint messages_station_code_chk check (station_code ~ '^[A-Z0-9]{4,5}$'),
  constraint messages_raw_text_chk check (btrim(raw_text) <> ''),
  constraint messages_normalized_text_chk check (btrim(normalized_text) <> ''),
  constraint messages_content_hash_chk check (content_hash ~ '^[0-9a-f]{64}$'),
  constraint messages_payload_object_chk check (jsonb_typeof(payload) = 'object'),
  constraint messages_duplicate_count_chk check (duplicate_count >= 0),
  constraint messages_event_time_chk check (
    (message_type = 'TAF' and issued_at is not null)
    or (message_type <> 'TAF' and observed_at is not null)
  ),
  constraint messages_validity_chk check (valid_to is null or valid_from is null or valid_to >= valid_from),
  constraint messages_visibility_chk check (visibility_m is null or visibility_m >= 0),
  constraint messages_wind_direction_chk check (wind_direction_deg is null or wind_direction_deg between 0 and 360),
  constraint messages_wind_speed_chk check (wind_speed_kt is null or wind_speed_kt >= 0),
  constraint messages_gust_chk check (gust_kt is null or gust_kt >= 0),
  constraint messages_ceiling_chk check (ceiling_ft is null or ceiling_ft >= 0)
);

create unique index if not exists messages_content_hash_uidx
  on public.messages (content_hash);
create index if not exists messages_type_station_archive_idx
  on public.messages (message_type, station_code, archive_time desc, id desc);
create index if not exists messages_type_archive_idx
  on public.messages (message_type, archive_time desc, id desc);
create index if not exists messages_station_archive_idx
  on public.messages (station_code, archive_time desc, id desc);
create index if not exists messages_archive_idx
  on public.messages (archive_time desc, id desc);
create index if not exists messages_station_id_idx
  on public.messages (station_id) where station_id is not null;
create index if not exists messages_source_id_idx
  on public.messages (source_id) where source_id is not null;

alter table public.message_sources enable row level security;
alter table public.stations enable row level security;
alter table public.messages enable row level security;

revoke all on table public.message_sources from public, anon, authenticated;
revoke all on table public.stations from public, anon, authenticated;
revoke all on table public.messages from public, anon, authenticated;

grant select on table public.message_sources, public.stations, public.messages to service_role;
grant insert, update on table public.messages to service_role;

do $$
declare
  v_sequence text;
begin
  v_sequence := pg_get_serial_sequence('public.messages', 'id');
  if v_sequence is not null then
    execute format('revoke all on sequence %s from public, anon, authenticated', v_sequence::regclass);
    execute format('grant usage, select on sequence %s to service_role', v_sequence::regclass);
  end if;
end $$;

drop policy if exists stations_public_read on public.stations;
drop policy if exists messages_public_read on public.messages;

-- The Edge Function validates and projects each object. This database function
-- makes the final batch write atomic and prevents a hash conflict from updating
-- a row with a different message identity.
create or replace function public.ingest_message_batch(p_messages jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_expected integer;
  v_touched integer;
  v_inserted integer;
begin
  if jsonb_typeof(p_messages) <> 'array' then
    raise exception 'p_messages must be a JSON array' using errcode = '22023';
  end if;

  v_expected := jsonb_array_length(p_messages);
  if v_expected < 1 or v_expected > 500 then
    raise exception 'p_messages batch size must be between 1 and 500' using errcode = '22023';
  end if;

  with input as (
    select incoming.*, station.id as station_id
    from jsonb_to_recordset(p_messages) as incoming(
      content_hash text,
      message_type text,
      station_code text,
      observed_at timestamptz,
      issued_at timestamptz,
      valid_from timestamptz,
      valid_to timestamptz,
      raw_text text,
      normalized_text text,
      source_ref text,
      payload jsonb,
      archive_time timestamptz,
      visibility_m integer,
      wind_direction_deg integer,
      wind_speed_kt double precision,
      gust_kt double precision,
      temperature_c double precision,
      qnh_hpa double precision,
      ceiling_ft integer,
      weather_codes text[],
      has_fg boolean,
      has_br boolean,
      has_mifg boolean,
      has_ts boolean,
      has_ra boolean,
      has_sn boolean,
      has_cb boolean,
      has_tcu boolean,
      has_vv boolean
    )
    left join lateral (
      select candidate.id
      from public.stations candidate
      where (
        incoming.station_code ~ '^[0-9]{5}$'
        and candidate.wmo = incoming.station_code
      ) or (
        incoming.station_code !~ '^[0-9]{5}$'
        and candidate.icao = incoming.station_code
      )
      limit 1
    ) as station on true
  ), upserted as (
    insert into public.messages as existing (
      content_hash, message_type, station_id, station_code,
      observed_at, issued_at, valid_from, valid_to,
      raw_text, normalized_text, source_ref, payload, archive_time,
      visibility_m, wind_direction_deg, wind_speed_kt, gust_kt,
      temperature_c, qnh_hpa, ceiling_ft, weather_codes,
      has_fg, has_br, has_mifg, has_ts, has_ra, has_sn, has_cb, has_tcu, has_vv
    )
    select
      content_hash, message_type, station_id, station_code,
      observed_at, issued_at, valid_from, valid_to,
      raw_text, normalized_text, source_ref, payload, archive_time,
      visibility_m, wind_direction_deg, wind_speed_kt, gust_kt,
      temperature_c, qnh_hpa, ceiling_ft, coalesce(weather_codes, '{}'),
      coalesce(has_fg, false), coalesce(has_br, false), coalesce(has_mifg, false),
      coalesce(has_ts, false), coalesce(has_ra, false), coalesce(has_sn, false),
      coalesce(has_cb, false), coalesce(has_tcu, false), coalesce(has_vv, false)
    from input
    on conflict (content_hash) do update
    set
      station_id = coalesce(existing.station_id, excluded.station_id),
      source_ref = coalesce(existing.source_ref, excluded.source_ref),
      last_seen_at = now(),
      duplicate_count = existing.duplicate_count + 1,
      visibility_m = coalesce(existing.visibility_m, excluded.visibility_m),
      wind_direction_deg = coalesce(existing.wind_direction_deg, excluded.wind_direction_deg),
      wind_speed_kt = coalesce(existing.wind_speed_kt, excluded.wind_speed_kt),
      gust_kt = coalesce(existing.gust_kt, excluded.gust_kt),
      temperature_c = coalesce(existing.temperature_c, excluded.temperature_c),
      qnh_hpa = coalesce(existing.qnh_hpa, excluded.qnh_hpa),
      ceiling_ft = coalesce(existing.ceiling_ft, excluded.ceiling_ft),
      weather_codes = case when cardinality(existing.weather_codes) = 0 then excluded.weather_codes else existing.weather_codes end,
      has_fg = existing.has_fg or excluded.has_fg,
      has_br = existing.has_br or excluded.has_br,
      has_mifg = existing.has_mifg or excluded.has_mifg,
      has_ts = existing.has_ts or excluded.has_ts,
      has_ra = existing.has_ra or excluded.has_ra,
      has_sn = existing.has_sn or excluded.has_sn,
      has_cb = existing.has_cb or excluded.has_cb,
      has_tcu = existing.has_tcu or excluded.has_tcu,
      has_vv = existing.has_vv or excluded.has_vv
    where existing.message_type = excluded.message_type
      and existing.station_code = excluded.station_code
      and existing.normalized_text = excluded.normalized_text
    returning (xmax = 0) as inserted
  )
  select count(*)::integer, (count(*) filter (where inserted))::integer
  into v_touched, v_inserted
  from upserted;

  if v_touched <> v_expected then
    raise exception 'content hash conflicts with an unrelated message identity' using errcode = '23505';
  end if;

  return jsonb_build_object(
    'ok', true,
    'inserted', v_inserted,
    'duplicates', v_expected - v_inserted
  );
end;
$$;

revoke all on function public.ingest_message_batch(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_message_batch(jsonb) to service_role;
