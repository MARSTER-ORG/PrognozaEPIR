-- Safe pressure-based retention for alternate-airport message archive.
-- Live Supabase migration: 20260920124012 add_safe_message_archive_retention
-- Core archive protection: EPIR and SYNOP station 12342 are never eligible.

create extension if not exists pg_cron with schema pg_catalog;

create table if not exists public.message_retention_alt_stations (
  station_code text primary key,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  constraint message_retention_alt_station_code_chk check (station_code ~ '^[A-Z0-9]{4,5}$')
);

alter table public.message_retention_alt_stations enable row level security;
revoke all on table public.message_retention_alt_stations from public, anon, authenticated;

insert into public.message_retention_alt_stations (station_code, enabled)
values ('EPBY', true), ('EPKS', true), ('EPPW', true)
on conflict (station_code) do update set enabled = excluded.enabled;

create table if not exists public.message_retention_log (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default now(),
  database_bytes_before bigint not null,
  quota_bytes bigint not null,
  usage_percent numeric(7,3) not null,
  mode text not null,
  keep_days integer,
  batch_limit integer,
  eligible_rows integer not null default 0,
  deleted_rows integer not null default 0,
  cutoff timestamptz,
  note text
);

alter table public.message_retention_log enable row level security;
revoke all on table public.message_retention_log from public, anon, authenticated;

create or replace function public.run_message_archive_retention()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_quota_bytes constant bigint := 524288000; -- 500 MiB
  v_db_bytes bigint;
  v_usage numeric(7,3);
  v_mode text := 'none';
  v_keep_days integer := null;
  v_batch integer := null;
  v_cutoff timestamptz := null;
  v_eligible integer := 0;
  v_deleted integer := 0;
  v_note text;
begin
  -- Prevent overlapping retention runs.
  perform pg_advisory_xact_lock(640219026, 1);

  v_db_bytes := pg_database_size(current_database());
  v_usage := round((v_db_bytes::numeric * 100.0) / v_quota_bytes::numeric, 3);

  if v_usage < 75 then
    v_note := 'Below 75% threshold; no deletion.';
  else
    if v_usage >= 85 then
      v_mode := 'emergency';
      v_keep_days := 30;
      v_batch := 5000;
    else
      v_mode := 'normal';
      v_keep_days := 90;
      v_batch := 1000;
    end if;

    v_cutoff := now() - make_interval(days => v_keep_days);

    select count(*)::integer
      into v_eligible
    from public.messages m
    join public.message_retention_alt_stations s
      on s.station_code = m.station_code
     and s.enabled
    where m.archive_time < v_cutoff
      and m.station_code not in ('EPIR', '12342');

    if v_eligible > 0 then
      with doomed as (
        select m.id
        from public.messages m
        join public.message_retention_alt_stations s
          on s.station_code = m.station_code
         and s.enabled
        where m.archive_time < v_cutoff
          and m.station_code not in ('EPIR', '12342')
        order by m.archive_time asc, m.id asc
        limit v_batch
      ), deleted as (
        delete from public.messages m
        using doomed d
        where m.id = d.id
        returning 1
      )
      select count(*)::integer into v_deleted from deleted;

      v_note := format(
        'Deleted oldest alternate-airport rows only. Protected stations EPIR and 12342 are never eligible. Minimum retained history: %s days.',
        v_keep_days
      );
    else
      v_note := format(
        'Threshold reached but no alternate-airport rows older than %s days are eligible. Protected stations untouched.',
        v_keep_days
      );
    end if;
  end if;

  insert into public.message_retention_log (
    database_bytes_before, quota_bytes, usage_percent, mode,
    keep_days, batch_limit, eligible_rows, deleted_rows, cutoff, note
  ) values (
    v_db_bytes, v_quota_bytes, v_usage, v_mode,
    v_keep_days, v_batch, v_eligible, v_deleted, v_cutoff, v_note
  );

  return jsonb_build_object(
    'ok', true,
    'database_bytes', v_db_bytes,
    'quota_bytes', v_quota_bytes,
    'usage_percent', v_usage,
    'mode', v_mode,
    'keep_days', v_keep_days,
    'batch_limit', v_batch,
    'eligible_rows', v_eligible,
    'deleted_rows', v_deleted,
    'cutoff', v_cutoff,
    'note', v_note
  );
end;
$$;

revoke all on function public.run_message_archive_retention() from public, anon, authenticated;
grant execute on function public.run_message_archive_retention() to postgres, service_role;

-- Existing logical backup starts at 02:23 UTC. Retention runs later, at 04:17 UTC.
do $$
declare
  v_job_id bigint;
begin
  select jobid into v_job_id
  from cron.job
  where jobname = 'safe-message-archive-retention'
  limit 1;

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'safe-message-archive-retention',
    '17 4 * * *',
    'select public.run_message_archive_retention();'
  );
end $$;
