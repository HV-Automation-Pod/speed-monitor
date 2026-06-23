export const runtime = 'edge'

import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

const VALID_DAYS = [7, 30, 60, 90]

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

  // Parse + clamp days param
  const rawDays = parseInt(request.nextUrl.searchParams.get('days') ?? '30', 10)
  const days = VALID_DAYS.includes(rawDays) ? rawDays : 30

  const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10) // YYYY-MM-DD

  const { data, error } = await supabaseAdmin
    .from('daily_aggregates')
    .select('date, avg_download, avg_upload, avg_latency, test_count')
    .gte('date', sinceDate)
    .order('date', { ascending: true })

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch trends' }, { status: 500 })
  }

  const rows = data ?? []

  // Group rows by date and compute weighted fleet averages
  const byDate = new Map<string, { sumDownload: number; sumUpload: number; sumLatency: number; totalTests: number }>()
  for (const row of rows) {
    const key = row.date as string
    const entry = byDate.get(key) ?? { sumDownload: 0, sumUpload: 0, sumLatency: 0, totalTests: 0 }
    const count = (row.test_count as number) ?? 0
    entry.sumDownload += ((row.avg_download as number) ?? 0) * count
    entry.sumUpload += ((row.avg_upload as number) ?? 0) * count
    entry.sumLatency += ((row.avg_latency as number) ?? 0) * count
    entry.totalTests += count
    byDate.set(key, entry)
  }

  const chartData = Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, { sumDownload, sumUpload, sumLatency, totalTests }]) => ({
      date,
      avg_download: totalTests > 0 ? Math.round((sumDownload / totalTests) * 100) / 100 : 0,
      avg_upload: totalTests > 0 ? Math.round((sumUpload / totalTests) * 100) / 100 : 0,
      avg_latency: totalTests > 0 ? Math.round((sumLatency / totalTests) * 100) / 100 : 0,
    }))

  return NextResponse.json({ days, data: chartData })
}
