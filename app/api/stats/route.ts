
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

  // Query last 24h fleet stats
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabaseAdmin
    .from('speed_results')
    .select('device_id, download_mbps, upload_mbps, latency_ms')
    .gte('timestamp_utc', since24h)

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 })
  }

  const rows = data ?? []

  // Aggregate in JS (fleet is small enough; avoids needing raw SQL RPC)
  const deviceIds = new Set(rows.map((r) => r.device_id))
  const active_device_count = deviceIds.size

  const downloads = rows.map((r) => r.download_mbps).filter((v): v is number => v != null)
  const uploads = rows.map((r) => r.upload_mbps).filter((v): v is number => v != null)
  const latencies = rows.map((r) => r.latency_ms).filter((v): v is number => v != null)

  const avg = (arr: number[]) =>
    arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0

  return NextResponse.json({
    active_device_count,
    avg_download: Math.round(avg(downloads) * 100) / 100,
    avg_upload: Math.round(avg(uploads) * 100) / 100,
    avg_latency: Math.round(avg(latencies) * 100) / 100,
    test_count: rows.length,
  })
}
