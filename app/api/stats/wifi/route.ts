
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
    .select('band, ssid')
    .gte('timestamp_utc', since24h)

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch WiFi stats' }, { status: 500 })
  }

  const rows = data ?? []

  // Band distribution
  type BandKey = '2.4GHz' | '5GHz' | '6GHz' | 'unknown'
  const band_distribution: Record<BandKey, number> = {
    '2.4GHz': 0,
    '5GHz': 0,
    '6GHz': 0,
    unknown: 0,
  }

  // SSID counts
  const ssidCounts: Record<string, number> = {}

  for (const row of rows) {
    const band = row.band as BandKey | null
    const key: BandKey =
      band === '2.4GHz' || band === '5GHz' || band === '6GHz' ? band : 'unknown'
    band_distribution[key]++

    if (row.ssid) {
      ssidCounts[row.ssid] = (ssidCounts[row.ssid] ?? 0) + 1
    }
  }

  const top_ssids = Object.entries(ssidCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([ssid, count]) => ({ ssid, count }))

  return NextResponse.json({ band_distribution, top_ssids })
}
