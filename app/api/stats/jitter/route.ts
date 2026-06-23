
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
    .select('device_id, hostname, jitter_ms')
    .gte('timestamp_utc', since24h)
    .not('jitter_ms', 'is', null)

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch jitter stats' }, { status: 500 })
  }

  const rows = data ?? []

  // Fleet average jitter
  const allJitter = rows.map((r) => r.jitter_ms).filter((v): v is number => v != null)
  const fleet_avg_jitter =
    allJitter.length > 0
      ? Math.round((allJitter.reduce((a, b) => a + b, 0) / allJitter.length) * 100) / 100
      : 0

  // Per-device average jitter
  const deviceJitter: Record<string, { device_id: string; hostname: string | null; values: number[] }> =
    {}

  for (const row of rows) {
    if (row.jitter_ms == null) continue
    if (!deviceJitter[row.device_id]) {
      deviceJitter[row.device_id] = {
        device_id: row.device_id,
        hostname: row.hostname ?? null,
        values: [],
      }
    }
    deviceJitter[row.device_id].values.push(row.jitter_ms)
  }

  const top_problem_devices = Object.values(deviceJitter)
    .map(({ device_id, hostname, values }) => ({
      device_id,
      hostname,
      avg_jitter:
        Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100,
    }))
    .sort((a, b) => b.avg_jitter - a.avg_jitter)
    .slice(0, 5)

  return NextResponse.json({ fleet_avg_jitter, top_problem_devices })
}
