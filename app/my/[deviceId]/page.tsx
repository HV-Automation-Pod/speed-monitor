import { redirect } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { computeHealthStatus } from '@/lib/admin/health'
import type { HealthStatus } from '@/lib/admin/health'
import { generateRecommendations } from '@/lib/admin/recommendations'
import EmployeeDashboard from '@/components/my/EmployeeDashboard'

export const dynamic = 'force-dynamic'

export default async function MyDevicePage({
  params,
}: {
  params: Promise<{ deviceId: string }>
}) {
  const { deviceId } = await params

  // Auth check — layout already gates, but belt-and-suspenders per CVE-2025-29927 pattern
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')

  // Ownership check — verify this employee has results posted for this deviceId
  // Prevents any authenticated @hyperverge.co user from viewing another employee's data
  const { data: ownership } = await supabaseAdmin
    .from('speed_results')
    .select('device_id')
    .eq('device_id', deviceId)
    .eq('user_email', user.email)
    .limit(1)
    .maybeSingle()
  if (!ownership) redirect('/my')

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const [last10Result, chart24hResult, baselineResult] = await Promise.all([
    supabaseAdmin
      .from('speed_results')
      .select('*')
      .eq('device_id', deviceId)
      .order('timestamp_utc', { ascending: false })
      .limit(10),
    supabaseAdmin
      .from('speed_results')
      .select('timestamp_utc, download_mbps, upload_mbps')
      .eq('device_id', deviceId)
      .gte('timestamp_utc', since24h)
      .order('timestamp_utc', { ascending: true }),
    supabaseAdmin
      .from('device_baselines')
      .select('mean, std_dev')
      .eq('device_id', deviceId)
      .eq('metric', 'download_mbps')
      .maybeSingle(),
  ])

  const last10Tests = last10Result.data ?? []
  const chart24hData = chart24hResult.data ?? []
  const baseline = baselineResult.data

  const lastTest = last10Tests[0] ?? null

  // IMPORTANT: Check for null lastTest BEFORE calling computeHealthStatus
  // computeHealthStatus returns 'red' for null lastSeenAt — employees should see 'unknown' (grey)
  let health: HealthStatus
  if (lastTest === null) {
    health = 'unknown'
  } else {
    health = computeHealthStatus(
      lastTest.download_mbps ?? null,
      baseline?.mean ?? null,
      baseline?.std_dev ?? null,
      lastTest.timestamp_utc ?? null,
    )
  }

  const recommendations = generateRecommendations(last10Tests, baseline?.mean ?? null)

  return (
    <EmployeeDashboard
      deviceId={deviceId}
      hostname={lastTest?.hostname ?? null}
      health={health}
      lastTest={lastTest}
      chart24hData={chart24hData}
      last10Tests={last10Tests}
      recommendations={recommendations}
    />
  )
}
