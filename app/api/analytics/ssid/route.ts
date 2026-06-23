export const runtime = 'edge'

import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { SsidRow } from '@/lib/analytics/types'

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
    .select('device_id, ssid, download_mbps, upload_mbps, latency_ms')
    .gte('timestamp_utc', since30d)
    .not('ssid', 'is', null)
    .limit(50000)

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch SSID stats' }, { status: 500 })
  }

  const rows = data ?? []

  // Group by SSID
  interface SsidBucket {
    deviceIds: Set<string>
    sumDown: number
    downCount: number
    sumUp: number
    upCount: number
    sumLat: number
    latCount: number
  }

  const bySsid = new Map<string, SsidBucket>()

  for (const row of rows) {
    if (!row.ssid) continue

    const existing = bySsid.get(row.ssid) ?? {
      deviceIds: new Set<string>(),
      sumDown: 0,
      downCount: 0,
      sumUp: 0,
      upCount: 0,
      sumLat: 0,
      latCount: 0,
    }

    existing.deviceIds.add(row.device_id)
    if (row.download_mbps != null) { existing.sumDown += row.download_mbps; existing.downCount++ }
    if (row.upload_mbps != null) { existing.sumUp += row.upload_mbps; existing.upCount++ }
    if (row.latency_ms != null) { existing.sumLat += row.latency_ms; existing.latCount++ }

    bySsid.set(row.ssid, existing)
  }

  const result: SsidRow[] = Array.from(bySsid.entries()).map(([ssid, b]) => ({
    ssid,
    device_count: b.deviceIds.size,
    avg_download: b.downCount > 0 ? Math.round((b.sumDown / b.downCount) * 100) / 100 : null,
    avg_upload:   b.upCount   > 0 ? Math.round((b.sumUp   / b.upCount  ) * 100) / 100 : null,
    avg_latency:  b.latCount  > 0 ? Math.round((b.sumLat  / b.latCount ) * 100) / 100 : null,
  }))

  // Sort by avg_download descending, nulls last
  result.sort((a, b) => {
    if (a.avg_download == null && b.avg_download == null) return 0
    if (a.avg_download == null) return 1
    if (b.avg_download == null) return -1
    return b.avg_download - a.avg_download
  })

  return NextResponse.json({ rows: result })
}
