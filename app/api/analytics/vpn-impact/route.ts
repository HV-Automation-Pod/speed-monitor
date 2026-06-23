export const runtime = 'edge'

import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { VpnImpactRow } from '@/lib/analytics/types'

export async function GET() {
  // Auth check
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: profile } = await supabase.from('profiles').select('role').eq('user_id', user.id).single()
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabaseAdmin
    .from('speed_results')
    .select('device_id, hostname, vpn_status, download_mbps, upload_mbps, latency_ms')
    .gte('timestamp_utc', since30d)
    .not('vpn_status', 'is', null)
    .limit(50000)

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch VPN impact stats' }, { status: 500 })
  }

  const rows = data ?? []

  // Group by device_id × vpn_status using a Map
  interface DeviceVpnBucket {
    hostname: string | null
    connected: { sumDown: number; sumUp: number; sumLat: number; count: number }
    disconnected: { sumDown: number; sumUp: number; sumLat: number; count: number }
  }

  const byDevice = new Map<string, DeviceVpnBucket>()

  for (const row of rows) {
    if (row.vpn_status !== 'connected' && row.vpn_status !== 'disconnected') continue

    const existing = byDevice.get(row.device_id) ?? {
      hostname: row.hostname ?? null,
      connected: { sumDown: 0, sumUp: 0, sumLat: 0, count: 0 },
      disconnected: { sumDown: 0, sumUp: 0, sumLat: 0, count: 0 },
    }

    const bucket = existing[row.vpn_status as 'connected' | 'disconnected']
    if (row.download_mbps != null) bucket.sumDown += row.download_mbps
    if (row.upload_mbps != null) bucket.sumUp += row.upload_mbps
    if (row.latency_ms != null) bucket.sumLat += row.latency_ms
    bucket.count++

    byDevice.set(row.device_id, existing)
  }

  const avgOrNull = (sum: number, count: number) =>
    count > 0 ? Math.round((sum / count) * 100) / 100 : null

  const result: VpnImpactRow[] = []

  for (const [device_id, b] of byDevice) {
    const onDown = avgOrNull(b.connected.sumDown, b.connected.count)
    const onUp = avgOrNull(b.connected.sumUp, b.connected.count)
    const onLat = avgOrNull(b.connected.sumLat, b.connected.count)
    const offDown = avgOrNull(b.disconnected.sumDown, b.disconnected.count)
    const offUp = avgOrNull(b.disconnected.sumUp, b.disconnected.count)
    const offLat = avgOrNull(b.disconnected.sumLat, b.disconnected.count)

    // Skip devices with no valid data for either state
    if (onDown == null && offDown == null) continue

    const deltaDownload =
      onDown != null && offDown != null
        ? Math.round((offDown - onDown) * 100) / 100  // positive = VPN hurts download
        : null

    result.push({
      device_id,
      hostname: b.hostname,
      on_download: onDown,
      on_upload: onUp,
      on_latency: onLat,
      off_download: offDown,
      off_upload: offUp,
      off_latency: offLat,
      delta_download: deltaDownload,
    })
  }

  // Sort by delta_download descending (biggest VPN impact first), nulls last
  result.sort((a, b) => {
    if (a.delta_download == null && b.delta_download == null) return 0
    if (a.delta_download == null) return 1
    if (b.delta_download == null) return -1
    return b.delta_download - a.delta_download
  })

  return NextResponse.json({ rows: result })
}
