-- 0008_batch_ingest_prep.sql
-- Prepares speed_results, device_api_keys, and remote_commands for batched
-- ingest via Supabase Edge Functions (PR #3) and per-device feature-flagged
-- rollout (PR #5).
--
-- Safety:
--   - speed_results dedup keeps the highest-id row per (device_id, timestamp_utc).
--   - device_api_keys.batching_enabled defaults to false, so existing client
--     behavior is preserved until flipped per-device.
--   - remote_commands.command is free-text TEXT; no schema change needed to
--     accept the new 'flush_now' command.
--
-- Run window: applies cleanly during the current Vercel outage (no concurrent
-- writers). Takes a brief ACCESS EXCLUSIVE lock on speed_results during the
-- constraint add; no other sessions are writing so it's effectively instant.

begin;

-- 1. Remove duplicate (device_id, timestamp_utc) rows so the unique constraint
--    can be added. Keep the row with the largest id (most recent insertion).
with duplicates as (
  select id,
         row_number() over (
           partition by device_id, timestamp_utc
           order by id desc
         ) as rn
  from public.speed_results
)
delete from public.speed_results
where id in (select id from duplicates where rn > 1);

-- 2. Unique constraint for idempotent batch retries (ON CONFLICT DO NOTHING).
--    Identical (device_id, timestamp_utc) cannot be inserted twice — same
--    batch posted twice becomes a no-op rather than a duplicate row.
alter table public.speed_results
  add constraint speed_results_device_time_unique
  unique (device_id, timestamp_utc);

-- 3. Per-device kill switch for batched ingest behavior. Default false means
--    every existing device continues using the old single-result POST until
--    explicitly flipped via UPDATE during the staged rollout.
alter table public.device_api_keys
  add column batching_enabled boolean not null default false;

-- 4. Document the new command type. remote_commands.command is free-text,
--    so no constraint change is needed; the client and Edge Functions
--    just need to handle 'flush_now'.
comment on column public.remote_commands.command is
  'force_update | force_speedtest | restart_service | collect_diagnostics | flush_now';

commit;
