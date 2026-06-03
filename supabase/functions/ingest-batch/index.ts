// POST /functions/v1/ingest-batch
//
// Accepts a batch of speed-test results from a single authenticated device
// and inserts them with ON CONFLICT DO NOTHING (idempotent retry).
//
// Body:
//   { "results": [ <IngestPayload>, ... ] }   — preferred (new client)
//   <IngestPayload>                            — single result (back-compat for rollout)
//
// Cap: 100 results per request (matches client-side buffer cap).
//
// Security:
//   - X-Api-Key required (validates device against device_api_keys)
//   - Every result.device_id MUST match the authenticated deviceId, or the
//     request is rejected wholesale (403). Prevents cross-device spoofing
//     even if a single key is compromised.
//
// Side effects (after successful insert):
//   - Updates daily_aggregates once per (device, date) seen in batch
//   - Updates device_baselines for the MOST RECENT result with full metrics
//   - Evaluates alert thresholds on the MOST RECENT result only
//     (early-returns if no enabled configs — most batches won't trigger any DB work)
//
// Returns:
//   202 { ok: true, accepted, conflicts }   — accepted = rows inserted, conflicts = dupes skipped
//   400/401/403/422/500 with { error: '...' }

import { z } from 'https://esm.sh/zod@4.3.6'
import { supabaseAdmin } from '../_shared/admin.ts'
import { validateApiKey } from '../_shared/api-auth.ts'

const MAX_BATCH_SIZE = 100

const IngestPayload = z.object({
  device_id: z.string().min(1),
  hostname: z.string().optional(),
  timestamp_utc: z.string().datetime().optional(),
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
  // Performance
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
  user_email: z.email().optional(),
})

const BatchPayload = z.union([
  z.object({ results: z.array(IngestPayload).min(1).max(MAX_BATCH_SIZE) }),
  IngestPayload, // back-compat: a single result POST
])

type IngestPayloadType = z.infer<typeof IngestPayload>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  // 1. Authenticate
  const auth = await validateApiKey(request)
  if (!auth) return json({ error: 'Unauthorized' }, 401)

  // 2. Parse + validate
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 422)
  }

  const parsed = BatchPayload.safeParse(body)
  if (!parsed.success) {
    return json({ error: 'Validation failed', issues: parsed.error.issues }, 422)
  }

  // Normalize single-result POST into an array.
  const results: IngestPayloadType[] =
    'results' in parsed.data ? parsed.data.results : [parsed.data]

  // 3. Cross-device spoof check: every result must belong to the authenticated device
  for (const r of results) {
    if (r.device_id !== auth.deviceId) {
      return json({ error: 'Forbidden: device_id mismatch in batch' }, 403)
    }
  }

  // 4. Bulk insert. ON CONFLICT (device_id, timestamp_utc) DO NOTHING via
  //    the unique constraint added in migration 0008. Same batch sent twice
  //    becomes a no-op — caller's retry logic stays simple.
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from('speed_results')
    .upsert(results, { onConflict: 'device_id,timestamp_utc', ignoreDuplicates: true })
    .select('id')

  if (insertError) {
    console.error('[ingest-batch] insert error:', insertError)
    return json({ error: 'Internal server error' }, 500)
  }

  const accepted = inserted?.length ?? 0
  const conflicts = results.length - accepted

  // 5. Daily aggregate update — once per unique date in the batch (almost always 1).
  //    Iterates results in order, accumulates per-date avg, then calls the same
  //    RPC the legacy Vercel handler uses. RPC is idempotent on conflict.
  const byDate: Record<string, IngestPayloadType[]> = {}
  for (const r of results) {
    const hasMetrics =
      r.download_mbps != null && r.upload_mbps != null && r.latency_ms != null
    if (!hasMetrics) continue
    const date =
      (r.timestamp_utc ? new Date(r.timestamp_utc) : new Date())
        .toISOString()
        .split('T')[0]
    ;(byDate[date] ??= []).push(r)
  }

  await Promise.allSettled(
    Object.entries(byDate).map(async ([date, rows]) => {
      // Use the average of the batch for that date — closer to the truth than
      // upserting each row individually (which the legacy single-result handler
      // had to do because it saw one row at a time).
      const avg = (k: keyof IngestPayloadType) =>
        rows.reduce((s, r) => s + ((r[k] as number) ?? 0), 0) / rows.length
      return supabaseAdmin.rpc('upsert_daily_aggregate', {
        p_device_id: auth.deviceId,
        p_date: date,
        p_download: avg('download_mbps'),
        p_upload: avg('upload_mbps'),
        p_latency: avg('latency_ms'),
        p_jitter: avg('jitter_ms'),
      })
    }),
  )

  // 6. Update baselines + run alert check on the MOST RECENT result with full
  //    metrics. Running these for every row in a batch would inflate baselines
  //    and produce duplicate alert evaluations within the same 2-hour window.
  const mostRecent =
    [...results]
      .filter(
        (r) =>
          r.download_mbps != null && r.upload_mbps != null && r.latency_ms != null,
      )
      .sort((a, b) => {
        const aT = a.timestamp_utc ?? ''
        const bT = b.timestamp_utc ?? ''
        return aT < bT ? 1 : aT > bT ? -1 : 0
      })[0] ?? null

  if (mostRecent) {
    await Promise.allSettled([
      supabaseAdmin.rpc('upsert_device_baseline', {
        p_device_id: auth.deviceId,
        p_metric: 'download_mbps',
        p_value: mostRecent.download_mbps!,
      }),
      supabaseAdmin.rpc('upsert_device_baseline', {
        p_device_id: auth.deviceId,
        p_metric: 'upload_mbps',
        p_value: mostRecent.upload_mbps!,
      }),
      supabaseAdmin.rpc('upsert_device_baseline', {
        p_device_id: auth.deviceId,
        p_metric: 'latency_ms',
        p_value: mostRecent.latency_ms!,
      }),
    ])

    // Alert check is fire-and-forget but wrapped in EdgeRuntime.waitUntil so
    // the Edge runtime doesn't tear down the function before the work completes.
    // @ts-ignore — EdgeRuntime is provided by the Supabase Edge runtime
    EdgeRuntime.waitUntil(
      checkAlertThresholds(
        auth.deviceId,
        mostRecent.download_mbps ?? null,
        mostRecent.upload_mbps ?? null,
        mostRecent.latency_ms ?? null,
        mostRecent.hostname ?? null,
      ),
    )
  }

  return json({ ok: true, accepted, conflicts }, 202)
})

// ---------------------------------------------------------------------------
// Alert threshold check — early-returns when no enabled configs exist, which
// is the common case until alerts are wired up. Avoids the per-ingest cost
// the legacy handler paid even on empty config tables.
// ---------------------------------------------------------------------------
async function checkAlertThresholds(
  deviceId: string,
  download: number | null,
  upload: number | null,
  latency: number | null,
  hostname: string | null,
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

    const thresholdConfigs = configs.filter(
      (c: { alert_type: string | null }) => !c.alert_type || c.alert_type === 'threshold',
    )

    const triggered = thresholdConfigs.filter(
      (c: {
        scope: string
        scope_device_id: string | null
        metric: string
        threshold_value: number | null
      }) => {
        if (c.scope === 'device' && c.scope_device_id !== deviceId) return false
        const actual = metricMap[c.metric]
        if (actual == null || c.threshold_value == null) return false
        if (c.metric === 'latency_ms') return actual > c.threshold_value
        return actual < c.threshold_value
      },
    )

    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const dedup = await Promise.all(
      triggered.map(async (c: { id: number }) => {
        const { data: recent } = await supabaseAdmin
          .from('alert_history')
          .select('id')
          .eq('config_id', c.id)
          .eq('device_id', deviceId)
          .gte('triggered_at', oneHourAgo)
          .limit(1)
        return recent && recent.length > 0 ? null : c
      }),
    )
    const toFireThreshold = dedup.filter(Boolean) as typeof triggered

    // Z-score branch
    const zscopeConfigs = configs.filter(
      (c: { alert_type: string | null }) => c.alert_type === 'zscore',
    )

    let toFireZscore: typeof triggered = []
    if (zscopeConfigs.length > 0) {
      const { data: baselines } = await supabaseAdmin
        .from('device_baselines')
        .select('metric, mean, std_dev')
        .eq('device_id', deviceId)

      const baselineMap = Object.fromEntries(
        (baselines ?? []).map(
          (b: { metric: string; mean: number; std_dev: number }) => [
            b.metric,
            { mean: b.mean, std_dev: b.std_dev },
          ],
        ),
      )

      const zTriggered = zscopeConfigs.filter(
        (c: { metric: string; scope: string; scope_device_id: string | null }) => {
          if (c.scope === 'device' && c.scope_device_id !== deviceId) return false
          const actual = metricMap[c.metric]
          const bl = baselineMap[c.metric]
          if (actual == null || !bl || bl.std_dev <= 0) return false
          return Math.abs((actual - bl.mean) / bl.std_dev) > 2
        },
      )

      const zDedup = await Promise.all(
        zTriggered.map(async (c: { id: number }) => {
          const { data: recent } = await supabaseAdmin
            .from('alert_history')
            .select('id')
            .eq('config_id', c.id)
            .eq('device_id', deviceId)
            .gte('triggered_at', oneHourAgo)
            .limit(1)
          return recent && recent.length > 0 ? null : c
        }),
      )
      toFireZscore = zDedup.filter(Boolean) as typeof triggered
    }

    const toFireAll = [...toFireThreshold, ...toFireZscore]
    if (!toFireAll.length) return

    const rows = toFireAll.map(
      (c: { id: number; metric: string; threshold_value: number }) => ({
        config_id: c.id,
        device_id: deviceId,
        metric_value: metricMap[c.metric] as number,
        message: buildSlackMessage(
          c.metric,
          c.threshold_value,
          deviceId,
          metricMap[c.metric] as number,
          hostname,
        ),
        delivered: false,
      }),
    )

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('alert_history')
      .insert(rows)
      .select()

    if (insertError) {
      console.error('[ingest-batch] alert_history insert error:', insertError)
      return
    }

    const webhookUrl = Deno.env.get('SLACK_WEBHOOK_URL')
    if (webhookUrl && rows.length > 0) {
      await Promise.allSettled(
        rows.map(async (row) => {
          try {
            const resp = await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: row.message }),
            })
            if (!resp.ok) console.error('[ingest-batch] Slack non-2xx:', resp.status)
          } catch (err) {
            console.error('[ingest-batch] Slack fetch error:', err)
          }
        }),
      )
    }

    if (inserted && inserted.length > 0) {
      const ids = (inserted as { id: number }[]).map((r) => r.id)
      await supabaseAdmin.from('alert_history').update({ delivered: true }).in('id', ids)
    }
  } catch (err) {
    console.error('[ingest-batch] checkAlertThresholds unexpected error:', err)
  }
}

function buildSlackMessage(
  metric: string,
  thresholdValue: number,
  deviceId: string,
  actualValue: number,
  hostname: string | null,
): string {
  const host = hostname ?? deviceId
  const baseUrl =
    Deno.env.get('NEXT_PUBLIC_SITE_URL') ?? 'https://speed-monitor-six.vercel.app'
  const link = `${baseUrl}/admin/devices/${deviceId}`
  if (metric === 'download_mbps') {
    return `🔴 Speed alert: ${host} download dropped to ${actualValue.toFixed(1)} Mbps (threshold: ${thresholdValue} Mbps). View device → ${link}`
  }
  if (metric === 'upload_mbps') {
    return `🔴 Speed alert: ${host} upload dropped to ${actualValue.toFixed(1)} Mbps (threshold: ${thresholdValue} Mbps). View device → ${link}`
  }
  return `🔴 Latency alert: ${host} latency rose to ${actualValue.toFixed(0)} ms (threshold: ${thresholdValue} ms). View device → ${link}`
}
