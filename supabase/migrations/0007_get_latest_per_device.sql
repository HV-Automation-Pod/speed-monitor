create or replace function get_latest_per_device()
returns table (
  device_id text,
  hostname text,
  download_mbps double precision,
  upload_mbps double precision,
  latency_ms double precision,
  timestamp_utc timestamptz,
  band text,
  vpn_status text,
  ssid text,
  user_email text
) language sql stable as $$
  select distinct on (device_id)
    device_id::text,
    hostname,
    download_mbps,
    upload_mbps,
    latency_ms,
    timestamp_utc,
    band,
    vpn_status,
    ssid,
    user_email
  from speed_results
  order by device_id, timestamp_utc desc;
$$;
