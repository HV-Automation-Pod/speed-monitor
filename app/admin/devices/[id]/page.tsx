import { supabaseAdmin } from '@/lib/supabase/admin'
import { computeHealthStatus, HEALTH_LABELS, HealthStatus } from '@/lib/admin/health'
import { generateRecommendations } from '@/lib/admin/recommendations'
import DeviceSpeedChart from '@/components/admin/DeviceSpeedChart'
import DeviceTabs from '@/components/admin/DeviceTabs'

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

export default async function DeviceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  // Await params — Next.js 16 requirement
  const { id: deviceId } = await params

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  // Parallel data fetching
  const [last20Result, chart24hResult, baselineResult] = await Promise.all([
    // 1. Last 20 speed results
    supabaseAdmin
      .from('speed_results')
      .select(
        'id, timestamp_utc, download_mbps, upload_mbps, latency_ms, jitter_ms, ssid, status, hostname, band, channel, rssi_dbm, mcs_index, channel_width, vpn_status, vpn_name'
      )
      .eq('device_id', deviceId)
      .order('timestamp_utc', { ascending: false })
      .limit(20),
    // 2. Last 24h for chart
    supabaseAdmin
      .from('speed_results')
      .select('timestamp_utc, download_mbps, upload_mbps')
      .eq('device_id', deviceId)
      .gte('timestamp_utc', since24h)
      .order('timestamp_utc', { ascending: true }),
    // 3. Device baseline
    supabaseAdmin
      .from('device_baselines')
      .select('mean, std_dev, updated_at')
      .eq('device_id', deviceId)
      .eq('metric', 'download_mbps')
      .maybeSingle(),
  ])

  const last20Tests = last20Result.data ?? []
  const chart24hData = chart24hResult.data ?? []
  const baseline = baselineResult.data

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

          {/* Export CSV button */}
          <a
            href={`/api/devices/${deviceId}/export?days=30`}
            download
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 transition-colors"
          >
            Export CSV
          </a>
        </div>
      </div>

      {/* Tab content */}
      <div className="px-6 py-6">
        <DeviceTabs defaultTab="overview">
          {{
            overview: (
              <div className="space-y-6">
                {/* 24h speed chart */}
                <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                  <h2 className="text-base font-semibold text-gray-900 mb-4">
                    Speed — Last 24 Hours
                  </h2>
                  <DeviceSpeedChart data={chart24hData} />
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
                <div className="px-6 py-4 border-b border-gray-200">
                  <h2 className="text-base font-semibold text-gray-900">
                    Test History (last 20)
                  </h2>
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
                      {last20Tests.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                            No test history available
                          </td>
                        </tr>
                      ) : (
                        last20Tests.map((test) => (
                          <tr key={test.id} className="hover:bg-gray-50">
                            <td className="px-4 py-3 text-gray-600 whitespace-nowrap">
                              {test.timestamp_utc
                                ? new Date(test.timestamp_utc).toLocaleString()
                                : '—'}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {test.download_mbps != null
                                ? test.download_mbps.toFixed(1)
                                : '—'}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {test.upload_mbps != null
                                ? test.upload_mbps.toFixed(1)
                                : '—'}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {test.latency_ms != null ? test.latency_ms : '—'}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">
                              {test.jitter_ms != null ? test.jitter_ms : '—'}
                            </td>
                            <td className="px-4 py-3 text-gray-600">
                              {test.ssid ?? '—'}
                            </td>
                            <td
                              className="px-4 py-3 font-medium capitalize"
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
      </div>
    </div>
  )
}
