
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

export async function GET(request: NextRequest) {
  // Auth + admin role check
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', user.id)
    .single()
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const rawDays = parseInt(request.nextUrl.searchParams.get('days') ?? '30', 10)
  const days = rawDays > 0 ? rawDays : 30

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabaseAdmin
    .from('speed_results')
    .select('timestamp_utc, download_mbps')
    .gte('timestamp_utc', since)
    .not('download_mbps', 'is', null)

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch time-of-day data' }, { status: 500 })
  }

  const rows = data ?? []

  // Bucket download speeds by hour 0–23
  const buckets: { sum: number; count: number }[] = Array.from({ length: 24 }, () => ({ sum: 0, count: 0 }))
  for (const row of rows) {
    const hour = new Date(row.timestamp_utc as string).getUTCHours()
    buckets[hour].sum += (row.download_mbps as number)
    buckets[hour].count += 1
  }

  const hours = buckets.map((bucket, hour) => ({
    hour,
    avg_download: bucket.count > 0 ? Math.round((bucket.sum / bucket.count) * 100) / 100 : null,
  }))

  return NextResponse.json({ days, hours })
}
