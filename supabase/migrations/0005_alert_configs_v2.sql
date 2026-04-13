-- Migration: 0005_alert_configs_v2
-- Purpose: Add per-metric threshold alerting columns to alert_configs.
--          Make webhook_url nullable (Slack delivery deferred to Phase 4).
--          Existing rows get default values so data is not corrupted.

ALTER TABLE alert_configs
  ADD COLUMN IF NOT EXISTS metric        text,
  ADD COLUMN IF NOT EXISTS scope         text NOT NULL DEFAULT 'all',
  ADD COLUMN IF NOT EXISTS scope_device_id text,
  ADD COLUMN IF NOT EXISTS enabled       boolean NOT NULL DEFAULT true;

-- Make webhook_url nullable (was NOT NULL in 0001_schema.sql)
ALTER TABLE alert_configs
  ALTER COLUMN webhook_url DROP NOT NULL;

-- Add check constraint on metric values
ALTER TABLE alert_configs
  ADD CONSTRAINT alert_configs_metric_check
    CHECK (metric IN ('download_mbps', 'upload_mbps', 'latency_ms'));

-- Add check constraint on scope values
ALTER TABLE alert_configs
  ADD CONSTRAINT alert_configs_scope_check
    CHECK (scope IN ('all', 'device'));

COMMENT ON COLUMN alert_configs.metric IS 'Which metric to threshold: download_mbps | upload_mbps | latency_ms';
COMMENT ON COLUMN alert_configs.scope IS 'all = all devices; device = specific device only';
COMMENT ON COLUMN alert_configs.scope_device_id IS 'device_id when scope = device; null when scope = all';
COMMENT ON COLUMN alert_configs.enabled IS 'false = rule saved but not evaluated during ingest';
