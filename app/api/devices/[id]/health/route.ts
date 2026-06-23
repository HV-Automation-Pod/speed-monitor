export const runtime = 'edge'

import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { computeHealthStatus } from '@/lib/admin/health'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Await params — Next.js 16 requirement
  const { id: deviceId } = await params

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

  // Fetch last 20 results + baseline in parallel
  const [resultsResult, baselineResult] = await Promise.all([
    supabaseAdmin
      .from('speed_results')
      .select('*')
      .eq('device_id', deviceId)
      .order('timestamp_utc', { ascending: false })
      .limit(20),
    supabaseAdmin
      .from('device_baselines')
      .select('mean, std_dev, updated_at')
      .eq('device_id', deviceId)
      .eq('metric', 'download_mbps')
      .single(),
  ])

  if (resultsResult.error) {
    return NextResponse.json({ error: 'Failed to fetch device results' }, { status: 500 })
  }

  const tests = resultsResult.data ?? []
  const baseline = baselineResult.data ?? null
  const lastResult = tests[0] ?? null

  const health = computeHealthStatus(
    lastResult?.download_mbps ?? null,
    baseline?.mean ?? null,
    baseline?.std_dev ?? null,
    lastResult?.timestamp_utc ?? null,
  )

  return NextResponse.json({
    device_id: deviceId,
    hostname: lastResult?.hostname ?? null,
    health,
    last_seen: lastResult?.timestamp_utc ?? null,
    last_20_tests: tests,
    baseline: baseline ? { mean: baseline.mean, std_dev: baseline.std_dev } : null,
  })
}
