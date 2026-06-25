import { redirect } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { computeHealthStatus } from '@/lib/admin/health'
import type { HealthStatus } from '@/lib/admin/health'
import { generateRecommendations } from '@/lib/admin/recommendations'
import { isScoped, ALL_SSIDS } from '@/lib/admin/ssid'
import EmployeeDashboard from '@/components/my/EmployeeDashboard'
import SsidFilter from '@/components/admin/SsidFilter'

export const dynamic = 'force-dynamic'

export default async function MyDevicePage({
  params,
  searchParams,
}: {
  params: Promise<{ deviceId: string }>
  searchParams: Promise<{ ssid?: string }>
}) {
  const { deviceId } = await params
  // Default to all networks (employees work anywhere); dropdown can isolate one.
  const ssid = (await searchParams).ssid ?? ALL_SSIDS

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
  const since60d = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()

  // The 24h chart scopes to the selected network; health/recommendations stay
  // whole-device (computed from the last 10 tests across all networks).
  let chart24hQuery = supabaseAdmin
    .from('speed_results')
    .select('timestamp_utc, download_mbps, upload_mbps')
    .eq('device_id', deviceId)
    .gte('timestamp_utc', since24h)
    .order('timestamp_utc', { ascending: true })
  if (isScoped(ssid)) chart24hQuery = chart24hQuery.eq('ssid', ssid)

  const [last10Result, chart24hResult, baselineResult, deviceSsidsResult] = await Promise.all([
    supabaseAdmin
      .from('speed_results')
      .select('*')
      .eq('device_id', deviceId)
      .order('timestamp_utc', { ascending: false })
      .limit(10),
    chart24hQuery,
    supabaseAdmin
      .from('device_baselines')
      .select('mean, std_dev')
      .eq('device_id', deviceId)
      .eq('metric', 'download_mbps')
      .maybeSingle(),
    supabaseAdmin
      .from('speed_results')
      .select('ssid')
      .eq('device_id', deviceId)
      .gte('timestamp_utc', since60d)
      .not('ssid', 'is', null)
      .limit(5000),
  ])

  const last10Tests = last10Result.data ?? []
  const chart24hData = chart24hResult.data ?? []
  const baseline = baselineResult.data

  const deviceSsidCounts = new Map<string, number>()
  for (const r of deviceSsidsResult.data ?? []) {
    const s = (r.ssid as string | null) ?? ''
    if (s) deviceSsidCounts.set(s, (deviceSsidCounts.get(s) ?? 0) + 1)
  }
  const ssidOptions = Array.from(deviceSsidCounts.entries())
    .map(([ssid, count]) => ({ ssid, count }))
    .sort((a, b) => b.count - a.count)

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
      ssidFilter={
        ssidOptions.length > 1
          ? <SsidFilter current={ssid} options={ssidOptions} persist={false} />
          : null
      }
    />
  )
}
