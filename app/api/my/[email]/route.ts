
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { computeHealthStatus } from '@/lib/admin/health'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ email: string }> },
) {
  // Await params — Next.js 16 requirement
  const { email } = await params
  const decodedEmail = decodeURIComponent(email)

  // Auth check (any authenticated user)
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  // Role check: non-admins can only query their own email
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', user.id)
    .single()

  const isAdmin = profile?.role === 'admin'
  if (!isAdmin && user.email !== decodedEmail) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Get all distinct device IDs that have posted results tagged with this email
  const { data: mappings, error: mapError } = await supabaseAdmin
    .from('speed_results')
    .select('device_id')
    .eq('user_email', decodedEmail)
    .order('timestamp_utc', { ascending: false })
    .limit(500)

  if (mapError) {
    return NextResponse.json({ error: 'Failed to fetch device mappings' }, { status: 500 })
  }

  const deviceIds = [...new Set((mappings ?? []).map((m) => m.device_id as string))]

  if (deviceIds.length === 0) {
    return NextResponse.json({ devices: [] })
  }

  // For each device, fetch last 10 results + baseline in parallel
  const deviceData = await Promise.all(
    deviceIds.map(async (deviceId) => {
      const [resultsResult, baselineResult] = await Promise.all([
        supabaseAdmin
          .from('speed_results')
          .select('*')
          .eq('device_id', deviceId)
          .order('timestamp_utc', { ascending: false })
          .limit(10),
        supabaseAdmin
          .from('device_baselines')
          .select('mean, std_dev')
          .eq('device_id', deviceId)
          .eq('metric', 'download_mbps')
          .single(),
      ])

      const tests = resultsResult.data ?? []
      const baseline = baselineResult.data
      const lastResult = tests[0] ?? null

      const health = computeHealthStatus(
        lastResult?.download_mbps ?? null,
        baseline?.mean ?? null,
        baseline?.std_dev ?? null,
        lastResult?.timestamp_utc ?? null,
      )

      return {
        device_id: deviceId,
        hostname: lastResult?.hostname ?? null,
        health,
        last_10_tests: tests,
      }
    }),
  )

  return NextResponse.json({ devices: deviceData })
}
