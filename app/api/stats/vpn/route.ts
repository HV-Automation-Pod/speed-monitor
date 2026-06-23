export const runtime = 'edge'

import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

export async function GET() {
  // Auth check
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: profile } = await supabase.from('profiles').select('role').eq('user_id', user.id).single()
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabaseAdmin
    .from('speed_results')
    .select('vpn_status, download_mbps, upload_mbps')
    .gte('timestamp_utc', since24h)

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch VPN stats' }, { status: 500 })
  }

  const rows = data ?? []

  // Build distribution and per-status averages
  type VpnKey = 'connected' | 'disconnected' | 'unknown'
  const distribution: Record<VpnKey, number> = { connected: 0, disconnected: 0, unknown: 0 }
  const byStatus: Record<VpnKey, { downloads: number[]; uploads: number[] }> = {
    connected: { downloads: [], uploads: [] },
    disconnected: { downloads: [], uploads: [] },
    unknown: { downloads: [], uploads: [] },
  }

  for (const row of rows) {
    const key: VpnKey =
      row.vpn_status === 'connected'
        ? 'connected'
        : row.vpn_status === 'disconnected'
        ? 'disconnected'
        : 'unknown'

    distribution[key]++
    if (row.download_mbps != null) byStatus[key].downloads.push(row.download_mbps)
    if (row.upload_mbps != null) byStatus[key].uploads.push(row.upload_mbps)
  }

  const avg = (arr: number[]) =>
    arr.length > 0 ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 : 0

  return NextResponse.json({
    distribution,
    avg_by_status: {
      connected: {
        download: avg(byStatus.connected.downloads),
        upload: avg(byStatus.connected.uploads),
      },
      disconnected: {
        download: avg(byStatus.disconnected.downloads),
        upload: avg(byStatus.disconnected.uploads),
      },
    },
  })
}
