import Link from 'next/link'
import { Suspense } from 'react'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { computeHealthStatus, HEALTH_LABELS, HealthStatus } from '@/lib/admin/health'
import { generateRecommendations } from '@/lib/admin/recommendations'
import { isScoped, ALL_SSIDS } from '@/lib/admin/ssid'
import DeviceSpeedChart from '@/components/admin/DeviceSpeedChart'
import DeviceTabs from '@/components/admin/DeviceTabs'
import DeleteDeviceButton from '@/components/admin/DeleteDeviceButton'
import LocalTime from '@/components/admin/LocalTime'
import SsidFilter from '@/components/admin/SsidFilter'

export const dynamic = 'force-dynamic'

// Inline style hex map — Tailwind v4 JIT requires static class names, no dynamic interpolation
const HEALTH_HEX: Record<HealthStatus, string> = {
  green: '#22c55e',
  yellow: '#facc15',
  red: '#ef4444',
  unknown: '#d1d5db',
}

function formatRelativeTime(utcString: string): string {
  const diffMs = Date.now() - new Date(utcString).getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 60) return `${diffMin} min ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? '' : 's'} ago`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay} day${diffDay === 1 ? '' : 's'} ago`
}

function statusCellColor(status: string | null): string {
  if (status === 'success') return '#d1fae5'   // green-100
  if (status === 'partial') return '#fef9c3'   // yellow-100
  if (status === 'error')   return '#fee2e2'   // red-100
  return 'transparent'
}

const HISTORY_PER_PAGE = 100

export default async function DeviceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ tab?: string; page?: string; ssid?: string }>
}) {
  // Await params — Next.js 16 requirement
  const { id: deviceId } = await params
  const { page: pageStr, ssid: ssidParam } = await searchParams
  const historyPage = Math.max(1, parseInt(pageStr ?? '1', 10))
  // Per-device default is "all networks" so home/café data isn't hidden; the
  // dropdown lets you isolate office (HypervergeHQ). URL-only (no fleet cookie).
  const ssid = ssidParam ?? ALL_SSIDS
  const scopeLabel = ssid === ALL_SSIDS ? 'all networks' : ssid

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const since60d = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

  // The speed charts scope to the selected SSID; everything else (health,
  // recommendations, full history, baseline) stays whole-device.
  let chart24hQuery = supabaseAdmin
    .from('speed_results')
    .select('timestamp_utc, download_mbps, upload_mbps')
    .eq('device_id', deviceId)
    .gte('timestamp_utc', since24h)
    .order('timestamp_utc', { ascending: true })
  if (isScoped(ssid)) chart24hQuery = chart24hQuery.eq('ssid', ssid)

  let chart7dQuery = supabaseAdmin
    .from('speed_results')
    .select('timestamp_utc, download_mbps, upload_mbps')
    .eq('device_id', deviceId)
    .gte('timestamp_utc', since7d)
    .order('timestamp_utc', { ascending: true })
    .limit(1500)
  if (isScoped(ssid)) chart7dQuery = chart7dQuery.eq('ssid', ssid)

  // Parallel data fetching
  const [last20Result, chart24hResult, baselineResult, chart7dResult, historyResult, deviceSsidsResult] = await Promise.all([
    // 1. Last 20 for health / recommendations / wifi tab (all networks)
    supabaseAdmin
      .from('speed_results')
      .select(
        'id, timestamp_utc, download_mbps, upload_mbps, latency_ms, jitter_ms, ssid, status, hostname, band, channel, rssi_dbm, mcs_index, channel_width, vpn_status, vpn_name'
      )
      .eq('device_id', deviceId)
      .order('timestamp_utc', { ascending: false })
      .limit(20),
    // 2. Last 24h for chart (SSID-scoped)
    chart24hQuery,
    // 3. Device baseline
    supabaseAdmin
      .from('device_baselines')
      .select('mean, std_dev, updated_at')
      .eq('device_id', deviceId)
      .eq('metric', 'download_mbps')
      .maybeSingle(),
    // 4. Last 7 days for chart toggle (SSID-scoped)
    chart7dQuery,
    // 5. Paginated 60-day history for history tab (all networks — shows SSID per row)
    supabaseAdmin
      .from('speed_results')
      .select('id, timestamp_utc, download_mbps, upload_mbps, latency_ms, jitter_ms, ssid, status', { count: 'exact' })
      .eq('device_id', deviceId)
      .gte('timestamp_utc', since60d)
      .order('timestamp_utc', { ascending: false })
      .range((historyPage - 1) * HISTORY_PER_PAGE, historyPage * HISTORY_PER_PAGE - 1),
    // 6. Networks this device has used (for the dropdown)
    supabaseAdmin
      .from('speed_results')
      .select('ssid')
      .eq('device_id', deviceId)
      .gte('timestamp_utc', since60d)
      .not('ssid', 'is', null)
      .limit(5000),
  ])

  const last20Tests = last20Result.data ?? []
  const chart24hData = chart24hResult.data ?? []
  const chart7dData = chart7dResult.data ?? []
  const baseline = baselineResult.data
  const historyTests = historyResult.data ?? []

  // Build SSID options scoped to this device.
  const deviceSsidCounts = new Map<string, number>()
  for (const r of deviceSsidsResult.data ?? []) {
    const s = (r.ssid as string | null) ?? ''
    if (s) deviceSsidCounts.set(s, (deviceSsidCounts.get(s) ?? 0) + 1)
  }
  const ssidOptions = Array.from(deviceSsidCounts.entries())
    .map(([ssid, count]) => ({ ssid, count }))
    .sort((a, b) => b.count - a.count)
  const historyTotal = historyResult.count ?? 0
  const historyFrom = historyTotal === 0 ? 0 : (historyPage - 1) * HISTORY_PER_PAGE + 1
  const historyTo = Math.min(historyPage * HISTORY_PER_PAGE, historyTotal)
  const historyPageCount = Math.ceil(historyTotal / HISTORY_PER_PAGE)

  const lastTest = last20Tests[0] ?? null

  // Compute health status
  const health = computeHealthStatus(
    lastTest?.download_mbps ?? null,
    baseline?.mean ?? null,
    baseline?.std_dev ?? null,
    lastTest?.timestamp_utc ?? null,
  )

  // Generate recommendations (direct call — no API round-trip)
  const recommendations = generateRecommendations(last20Tests, baseline?.mean ?? null)

  // Format last seen
  const lastSeen = lastTest?.timestamp_utc
    ? formatRelativeTime(lastTest.timestamp_utc)
    : 'Never'

  const hostname = lastTest?.hostname ?? deviceId

  return (
    <div className="min-h-full bg-gray-50">
      {/* Page header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-2">
          <Link href="/admin/devices" className="hover:text-indigo-600 flex items-center gap-1 transition-colors">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            All Devices
          </Link>
          <span>/</span>
          <span className="text-gray-600">{hostname}</span>
        </div>

        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <h1 className="text-xl font-semibold text-gray-900 truncate">
              {hostname}
            </h1>
            {/* Health badge — inline style (Tailwind v4 JIT requires static class names) */}
            <span
              className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium text-white"
              style={{ backgroundColor: HEALTH_HEX[health] }}
            >
              {HEALTH_LABELS[health]}
            </span>
            <span className="text-sm text-gray-500">
              Last seen: {lastSeen}
            </span>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 flex-wrap">
            <a
              href={`/api/devices/${deviceId}/export?days=60`}
              download
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Export CSV
            </a>
            <DeleteDeviceButton deviceId={deviceId} hostname={hostname} />
          </div>
        </div>
      </div>

      {/* Tab content */}
      <div className="px-6 py-6">
        <Suspense fallback={<div className="h-8 w-48 bg-gray-100 rounded animate-pulse" />}>
          <DeviceTabs>
            {{
              overview: (
                <div className="space-y-6">
                  {/* Speed chart with 24h/7d toggle — scoped to the selected network */}
                  <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                    <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
                      <h2 className="text-base font-semibold text-gray-900">
                        Speed over time · <span className="font-normal text-gray-500">{scopeLabel}</span>
                      </h2>
                      {ssidOptions.length > 1 && (
                        <SsidFilter current={ssid} options={ssidOptions} persist={false} />
                      )}
                    </div>
                    <DeviceSpeedChart data24h={chart24hData} data7d={chart7dData} />
                  </div>

                  {/* Recommendations */}
                  <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                    <h2 className="text-base font-semibold text-gray-900 mb-3">
                      Recommendations
                    </h2>
                    <ul className="space-y-2">
                      {recommendations.map((rec, i) => (
                        <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                          <span className="mt-0.5 w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                          {rec}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ),

              history: (
                <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                  <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
                    <h2 className="text-base font-semibold text-gray-900">
                      Test History (last 60 days)
                    </h2>
                    <span className="text-xs text-gray-400">
                      {historyTotal > 0
                        ? `Showing ${historyFrom}–${historyTo} of ${historyTotal}`
                        : 'No tests'}
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left">
                      <thead className="bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wider">
                        <tr>
                          <th className="px-4 py-3">Timestamp</th>
                          <th className="px-4 py-3 text-right">Download (Mbps)</th>
                          <th className="px-4 py-3 text-right">Upload (Mbps)</th>
                          <th className="px-4 py-3 text-right">Latency (ms)</th>
                          <th className="px-4 py-3 text-right">Jitter (ms)</th>
                          <th className="px-4 py-3">SSID</th>
                          <th className="px-4 py-3">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {historyTests.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                              No test history in the last 60 days
                            </td>
                          </tr>
                        ) : (
                          historyTests.map((test) => (
                            <tr key={test.id} className="hover:bg-gray-50">
                              <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                                {test.timestamp_utc
                                  ? <LocalTime utc={test.timestamp_utc} />
                                  : '—'}
                              </td>
                              <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                                {test.download_mbps != null
                                  ? test.download_mbps.toFixed(1)
                                  : '—'}
                              </td>
                              <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                                {test.upload_mbps != null
                                  ? test.upload_mbps.toFixed(1)
                                  : '—'}
                              </td>
                              <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                                {test.latency_ms != null ? test.latency_ms : '—'}
                              </td>
                              <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                                {test.jitter_ms != null ? test.jitter_ms : '—'}
                              </td>
                              <td className="px-4 py-3 text-gray-600">
                                {test.ssid ?? '—'}
                              </td>
                              <td
                                className="px-4 py-3 font-medium capitalize text-gray-700"
                                style={{ backgroundColor: statusCellColor(test.status) }}
                              >
                                {test.status ?? '—'}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                  {/* Pagination */}
                  {historyPageCount > 1 && (
                    <div className="px-6 py-3 border-t border-gray-100 flex items-center justify-between text-sm">
                      <span className="text-gray-500">
                        Page {historyPage} of {historyPageCount}
                      </span>
                      <div className="flex gap-2">
                        {historyPage > 1 && (
                          <Link
                            href={`?tab=history&page=${historyPage - 1}`}
                            className="px-3 py-1.5 rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors text-xs font-medium"
                          >
                            ← Previous
                          </Link>
                        )}
                        {historyPage < historyPageCount && (
                          <Link
                            href={`?tab=history&page=${historyPage + 1}`}
                            className="px-3 py-1.5 rounded-md border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors text-xs font-medium"
                          >
                            Next →
                          </Link>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ),

              wifi: (
                <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                  <h2 className="text-base font-semibold text-gray-900 mb-4">
                    WiFi Details
                  </h2>
                  {lastTest == null ? (
                    <p className="text-gray-400 text-sm">No data available</p>
                  ) : (
                    <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-5">
                      {[
                        { label: 'SSID', value: lastTest.ssid },
                        { label: 'Band', value: lastTest.band },
                        { label: 'Channel', value: lastTest.channel },
                        { label: 'RSSI (dBm)', value: lastTest.rssi_dbm },
                        { label: 'MCS Index', value: lastTest.mcs_index },
                        { label: 'Channel Width', value: lastTest.channel_width },
                        { label: 'VPN Status', value: lastTest.vpn_status },
                        { label: 'VPN Name', value: lastTest.vpn_name },
                      ].map(({ label, value }) => (
                        <div key={label}>
                          <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">
                            {label}
                          </dt>
                          <dd className="mt-1 text-sm font-semibold text-gray-900">
                            {value != null ? String(value) : '—'}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              ),
            }}
          </DeviceTabs>
        </Suspense>
      </div>
    </div>
  )
}
