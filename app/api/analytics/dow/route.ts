export const runtime = 'edge'

import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { DowRow } from '@/lib/analytics/types'

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
    .select('timestamp_utc, download_mbps')
    .gte('timestamp_utc', since30d)
    .not('download_mbps', 'is', null)
    .limit(50000)

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch DOW stats' }, { status: 500 })
  }

  const rows = data ?? []

  const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const byDow = new Map<number, { sum: number; count: number }>()

  for (const row of rows) {
    if (row.timestamp_utc == null || row.download_mbps == null) continue
    const dow = new Date(row.timestamp_utc).getUTCDay()  // 0=Sun ... 6=Sat
    const entry = byDow.get(dow) ?? { sum: 0, count: 0 }
    entry.sum += row.download_mbps
    entry.count++
    byDow.set(dow, entry)
  }

  // Output Mon–Sun order per success criteria (index 1–6 then 0)
  const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]
  const result: DowRow[] = DOW_ORDER.map(dow => ({
    day: DOW_LABELS[dow],
    avg_download: byDow.has(dow) && byDow.get(dow)!.count > 0
      ? Math.round((byDow.get(dow)!.sum / byDow.get(dow)!.count) * 100) / 100
      : null,
  }))

  return NextResponse.json({ rows: result })
}
