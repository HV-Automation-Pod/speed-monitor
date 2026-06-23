
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { validateApiKey } from '@/lib/supabase/api-auth'

// ---------------------------------------------------------------------------
// Payload schema — mirrors speed_results table columns.
// All optional except device_id (which is also validated against the API key).
// Range validations ensure no negative performance metrics enter the DB.
// ---------------------------------------------------------------------------
const IngestPayload = z.object({
  device_id: z.string().min(1),
  hostname: z.string().optional(),
  timestamp_utc: z.string().datetime().optional(), // defaults to now() in DB
  // WiFi
  ssid: z.string().optional(),
  bssid: z.string().optional(),
  band: z.string().optional(),
  channel: z.number().int().optional(),
  rssi_dbm: z.number().int().optional(),
  mcs_index: z.number().int().optional(),
  spatial_streams: z.number().int().optional(),
  snr_db: z.number().int().optional(),
  channel_width: z.string().optional(),
  // Performance (min(0) prevents negative metrics from corrupting baselines)
  download_mbps: z.number().min(0).optional(),
  upload_mbps: z.number().min(0).optional(),
  latency_ms: z.number().min(0).optional(),
  jitter_ms: z.number().min(0).optional(),
  packet_loss_pct: z.number().min(0).max(100).optional(),
  // VPN
  vpn_status: z.string().optional(),
  vpn_name: z.string().optional(),
  // Network health
  interface_errors_in: z.number().int().optional(),
  interface_errors_out: z.number().int().optional(),
  tcp_retransmits: z.number().int().optional(),
  bssid_changes: z.number().int().optional(),
  // Server connectivity
  server_url: z.string().optional(),
  public_ip: z.string().optional(),
  isp_name: z.string().optional(),
  // Status
  status: z.enum(['success', 'error', 'partial']).optional(),
  errors: z.string().optional(),
  client_version: z.string().optional(),
  os_version: z.string().optional(),
  user_email: z.string().email().optional(),
})

type IngestPayloadType = z.infer<typeof IngestPayload>

// ---------------------------------------------------------------------------
// POST /api/ingest/result
//
// This is the hot path: ~300 POSTs per 30 minutes from the macOS fleet.
//
// Flow:
//   1. Validate X-Api-Key header → 401 if missing/invalid
//   2. Verify device_id in payload matches device_id in API key → 403 if mismatch
//   3. Zod parse + validate payload → 422 if invalid
//   4. Insert row to speed_results
//   5. If metrics present: atomically update daily_aggregates and device_baselines
//      (4 RPC calls run in parallel via Promise.all)
//   6. Return 202 { ok: true }
//
// Error handling:
//   - DB insert error → log + return 500
//   - RPC update errors → log but still return 202 (aggregate/baseline failure
//     must never fail an ingest — we can rebuild rollups from speed_results)
// ---------------------------------------------------------------------------
export async function POST(request: Request) {
  // --- Step 1: Authenticate via X-Api-Key header ---
  const auth = await validateApiKey(request)
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // --- Step 2: Parse + validate payload ---
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 422 })
  }

  const parseResult = IngestPayload.safeParse(body)
  if (!parseResult.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parseResult.error.issues },
      { status: 422 }
    )
  }

  const data: IngestPayloadType = parseResult.data

  // --- Step 3: Prevent cross-device spoofing ---
  // The API key already encodes the device_id (prefix before ':'). Reject
  // any payload where device_id doesn't match the authenticated device.
  if (data.device_id !== auth.deviceId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // --- Step 4: Insert row to speed_results ---
  const { error: insertError } = await supabaseAdmin
    .from('speed_results')
    .insert(data)

  if (insertError) {
    console.error('[ingest/result] insert error:', insertError)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }

  // --- Step 5: Update rollups (fire-and-forget pattern with logged errors) ---
  // Only run if the core performance metrics are present. Partial payloads
  // (e.g. WiFi-only diagnostic) should not corrupt baselines with null values.
  const hasMetrics =
    data.download_mbps != null &&
    data.upload_mbps != null &&
    data.latency_ms != null

  if (hasMetrics) {
    const today = new Date().toISOString().split('T')[0] // "YYYY-MM-DD"
    const deviceId = data.device_id
    const download = data.download_mbps!
    const upload = data.upload_mbps!
    const latency = data.latency_ms!
    const jitter = data.jitter_ms ?? 0

    // Run all 4 RPC calls in parallel — each is atomic, idempotent on conflict
    const rpcResults = await Promise.allSettled([
      supabaseAdmin.rpc('upsert_daily_aggregate', {
        p_device_id: deviceId,
        p_date: today,
        p_download: download,
        p_upload: upload,
        p_latency: latency,
        p_jitter: jitter,
      }),
      supabaseAdmin.rpc('upsert_device_baseline', {
        p_device_id: deviceId,
        p_metric: 'download_mbps',
        p_value: download,
      }),
      supabaseAdmin.rpc('upsert_device_baseline', {
        p_device_id: deviceId,
        p_metric: 'upload_mbps',
        p_value: upload,
      }),
      supabaseAdmin.rpc('upsert_device_baseline', {
        p_device_id: deviceId,
        p_metric: 'latency_ms',
        p_value: latency,
      }),
    ])

    // Log any RPC errors but do NOT fail the request — ingest already succeeded
    for (const [idx, result] of rpcResults.entries()) {
      if (result.status === 'rejected') {
        console.error(`[ingest/result] rpc[${idx}] rejected:`, result.reason)
      } else if (result.value.error) {
        console.error(`[ingest/result] rpc[${idx}] error:`, result.value.error)
      }
    }
  }

  // --- Step 6: Alert threshold check (fire-and-forget — never blocks 202 response) ---
  void checkAlertThresholds(
    data.device_id,
    data.download_mbps ?? null,
    data.upload_mbps ?? null,
    data.latency_ms ?? null,
    data.hostname ?? null,
  )

  return NextResponse.json({ ok: true }, { status: 202 })
}

// ---------------------------------------------------------------------------
// buildSlackMessage
//
// Pure function — constructs a human-readable Slack message for an alert.
// Uses NEXT_PUBLIC_SITE_URL with fallback to VERCEL_URL then localhost.
// ---------------------------------------------------------------------------
function buildSlackMessage(
  metric: string,
  thresholdValue: number,
  deviceId: string,
  actualValue: number,
  hostname: string | null,
): string {
  const host = hostname ?? deviceId
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL
    ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000')
  const link = `${baseUrl}/admin/devices/${deviceId}`
  if (metric === 'download_mbps') {
    return `🔴 Speed alert: ${host} download dropped to ${actualValue.toFixed(1)} Mbps (threshold: ${thresholdValue} Mbps). View device → ${link}`
  }
  if (metric === 'upload_mbps') {
    return `🔴 Speed alert: ${host} upload dropped to ${actualValue.toFixed(1)} Mbps (threshold: ${thresholdValue} Mbps). View device → ${link}`
  }
  return `🔴 Latency alert: ${host} latency rose to ${actualValue.toFixed(0)} ms (threshold: ${thresholdValue} ms). View device → ${link}`
}

// ---------------------------------------------------------------------------
// checkAlertThresholds
//
// Runs asynchronously after every successful speed_results insert.
// Reads all enabled alert_configs, evaluates thresholds, and writes rows to
// alert_history for any rule that is violated. Never throws — errors are
// logged only.
//
// Threshold direction:
//   download_mbps / upload_mbps — alert if actual < threshold_value (too slow)
//   latency_ms                  — alert if actual > threshold_value (too high)
//
// Deduplication: skips configs that already fired within the last 60 minutes
// for the same device+config combo. Prevents Slack spam.
//
// Z-score branch: evaluates zscore-type configs against device_baselines.
// Fires when actual deviates more than 2 std devs from the baseline mean.
// ---------------------------------------------------------------------------
async function checkAlertThresholds(
  deviceId: string,
  download: number | null,
  upload: number | null,
  latency: number | null,
  hostname?: string | null,
): Promise<void> {
  try {
    const { data: configs, error } = await supabaseAdmin
      .from('alert_configs')
      .select('id, metric, threshold_value, alert_type, scope, scope_device_id')
      .eq('enabled', true)

    if (error || !configs?.length) return

    const metricMap: Record<string, number | null> = {
      download_mbps: download,
      upload_mbps: upload,
      latency_ms: latency,
    }

    // Threshold configs (alert_type = 'threshold' or null/unset)
    const thresholdConfigs = configs.filter(
      (cfg: { alert_type: string | null }) => !cfg.alert_type || cfg.alert_type === 'threshold'
    )

    const triggered = thresholdConfigs.filter(
      (cfg: { scope: string; scope_device_id: string | null; metric: string; threshold_value: number | null }) => {
        // Scope check: if scope is 'device', only match the specific device
        if (cfg.scope === 'device' && cfg.scope_device_id !== deviceId) return false

        const actual = metricMap[cfg.metric]
        if (actual == null || cfg.threshold_value == null) return false

        // For download/upload: alert if BELOW threshold; for latency: alert if ABOVE
        if (cfg.metric === 'latency_ms') return actual > cfg.threshold_value
        return actual < cfg.threshold_value
      }
    )

    // --- Dedup: filter configs that fired within the last 60 minutes ---
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const dedupChecks = await Promise.all(
      triggered.map(async (cfg: { id: number }) => {
        const { data: recent } = await supabaseAdmin
          .from('alert_history')
          .select('id')
          .eq('config_id', cfg.id)
          .eq('device_id', deviceId)
          .gte('triggered_at', oneHourAgo)
          .limit(1)
        return recent && recent.length > 0 ? null : cfg
      })
    )
    const toFireThreshold = dedupChecks.filter(Boolean) as typeof triggered

    // --- Z-score anomaly branch ---
    const zscopeConfigs = configs.filter(
      (cfg: { alert_type: string | null }) => cfg.alert_type === 'zscore'
    )

    const { data: baselines } = await supabaseAdmin
      .from('device_baselines')
      .select('metric, mean, std_dev')
      .eq('device_id', deviceId)

    const baselineMap = Object.fromEntries(
      (baselines ?? []).map((b: { metric: string; mean: number; std_dev: number }) => [
        b.metric,
        { mean: b.mean, std_dev: b.std_dev },
      ])
    )

    const zscoreTriggered = zscopeConfigs.filter(
      (cfg: { metric: string; scope: string; scope_device_id: string | null }) => {
        if (cfg.scope === 'device' && cfg.scope_device_id !== deviceId) return false
        const actual = metricMap[cfg.metric]
        const bl = baselineMap[cfg.metric]
        if (actual == null || !bl || bl.std_dev <= 0) return false
        const z = Math.abs((actual - bl.mean) / bl.std_dev)
        return z > 2
      }
    )

    // Dedup zscore configs too
    const zDedupChecks = await Promise.all(
      zscoreTriggered.map(async (cfg: { id: number }) => {
        const { data: recent } = await supabaseAdmin
          .from('alert_history')
          .select('id')
          .eq('config_id', cfg.id)
          .eq('device_id', deviceId)
          .gte('triggered_at', oneHourAgo)
          .limit(1)
        return recent && recent.length > 0 ? null : cfg
      })
    )
    const toFireZscore = zDedupChecks.filter(Boolean) as typeof zscoreTriggered

    const toFireAll = [...toFireThreshold, ...toFireZscore]
    if (!toFireAll.length) return

    // --- Build alert_history rows ---
    const resolvedHostname = hostname ?? null
    const rows = toFireAll.map((cfg: { id: number; metric: string; threshold_value: number }) => ({
      config_id: cfg.id,
      device_id: deviceId,
      metric_value: metricMap[cfg.metric] as number,
      message: buildSlackMessage(
        cfg.metric,
        cfg.threshold_value,
        deviceId,
        metricMap[cfg.metric] as number,
        resolvedHostname,
      ),
      delivered: false,
    }))

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('alert_history')
      .insert(rows)
      .select()

    if (insertError) {
      console.error('[ingest/result] alert_history insert error:', insertError)
      return
    }

    // --- Fire Slack webhook (fire-and-forget; log failure but always mark delivered) ---
    const webhookUrl = process.env.SLACK_WEBHOOK_URL
    if (webhookUrl && rows.length > 0) {
      await Promise.allSettled(
        rows.map(async (row) => {
          try {
            const resp = await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: row.message }),
            })
            if (!resp.ok) {
              console.error('[ingest/result] Slack webhook non-2xx:', resp.status)
            }
          } catch (err) {
            console.error('[ingest/result] Slack webhook fetch error:', err)
          }
        })
      )
    }

    // --- Mark delivered regardless of Slack outcome ---
    if (inserted && inserted.length > 0) {
      const ids = (inserted as { id: number }[]).map((r) => r.id)
      await supabaseAdmin
        .from('alert_history')
        .update({ delivered: true })
        .in('id', ids)
    }
  } catch (err) {
    console.error('[ingest/result] checkAlertThresholds unexpected error:', err)
  }
}
