import { supabaseAdmin } from '@/lib/supabase/admin'
import { computeHealthStatus } from '@/lib/admin/health'
import DeviceTable, { DeviceRow } from '@/components/admin/DeviceTable'
import JitterProblemDevices from '@/components/admin/JitterProblemDevices'

export const dynamic = 'force-dynamic'

type ValidSortColumn = 'download_mbps' | 'upload_mbps' | 'latency_ms' | 'timestamp_utc' | 'hostname' | 'band' | 'vpn_status' | 'ssid'

const VALID_SORT_COLUMNS: ValidSortColumn[] = [
  'download_mbps',
  'upload_mbps',
  'latency_ms',
  'timestamp_utc',
  'hostname',
  'band',
  'vpn_status',
  'ssid',
]

interface SearchParams {
  sort?: string
  order?: string
  vpn?: string
  band?: string
  ssid?: string
}

interface LatestDeviceRow {
  device_id: string
  hostname: string | null
  download_mbps: number | null
  upload_mbps: number | null
  latency_ms: number | null
  timestamp_utc: string | null
  band: string | null
  vpn_status: string | null
  ssid: string | null
  user_email: string | null
}

async function getJitterStats() {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const { data } = await supabaseAdmin
    .from('speed_results')
    .select('device_id, hostname, jitter_ms')
    .gte('timestamp_utc', since24h)
    .not('jitter_ms', 'is', null)

  const rows = data ?? []

  // Fleet average
  const allJitter = rows.map((r) => r.jitter_ms as number)
  const fleetAvg =
    allJitter.length > 0
      ? Math.round((allJitter.reduce((a, b) => a + b, 0) / allJitter.length) * 100) / 100
      : 0

  // Per-device average
  const byDevice: Record<string, { device_id: string; hostname: string | null; values: number[] }> = {}
  for (const row of rows) {
    if (row.jitter_ms == null) continue
    if (!byDevice[row.device_id]) {
      byDevice[row.device_id] = { device_id: row.device_id, hostname: row.hostname ?? null, values: [] }
    }
    byDevice[row.device_id].values.push(row.jitter_ms as number)
  }

  const topDevices = Object.values(byDevice)
    .map(({ device_id, hostname, values }) => ({
      device_id,
      hostname,
      avg_jitter: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100,
    }))
    .sort((a, b) => b.avg_jitter - a.avg_jitter)
    .slice(0, 5)

  return { fleetAvg, topDevices }
}

export default async function DevicesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  const params = await searchParams
  const sort = VALID_SORT_COLUMNS.includes(params.sort as ValidSortColumn)
    ? (params.sort as ValidSortColumn)
    : 'timestamp_utc'
  const order = params.order === 'asc' ? 'asc' : 'desc'
  const vpnFilter = params.vpn
  const bandFilter = params.band
  const ssidFilter = params.ssid

  // Use DISTINCT ON via RPC so every device appears regardless of how long it's been offline.
  // The composite index on (device_id, timestamp_utc DESC) makes this fast.
  let rpcQuery = supabaseAdmin.rpc('get_latest_per_device')
  if (vpnFilter) rpcQuery = rpcQuery.eq('vpn_status', vpnFilter)
  if (bandFilter) rpcQuery = rpcQuery.eq('band', bandFilter)
  if (ssidFilter) rpcQuery = rpcQuery.eq('ssid', ssidFilter)

  const [rpcResult, { data: baselines }, jitterStats] = await Promise.all([
    rpcQuery,
    supabaseAdmin
      .from('device_baselines')
      .select('device_id, mean, std_dev')
      .eq('metric', 'download_mbps'),
    getJitterStats(),
  ])

  const lastPerDevice: LatestDeviceRow[] = (rpcResult.data as LatestDeviceRow[] | null) ?? []

  const baselineMap = new Map(
    (baselines ?? []).map((b) => [b.device_id, b])
  )

  // Build DeviceRow array with health
  let devices: DeviceRow[] = lastPerDevice.map((r) => {
    const baseline = baselineMap.get(r.device_id)
    const health = computeHealthStatus(
      r.download_mbps,
      baseline?.mean ?? null,
      baseline?.std_dev ?? null,
      r.timestamp_utc,
    )
    return {
      device_id: r.device_id,
      hostname: r.hostname,
      health,
      download_mbps: r.download_mbps,
      upload_mbps: r.upload_mbps,
      latency_ms: r.latency_ms,
      timestamp_utc: r.timestamp_utc,
      band: r.band,
      vpn_status: r.vpn_status,
      ssid: r.ssid,
      user_email: r.user_email,
    }
  })

  // Sort in JS
  devices.sort((a, b) => {
    let aVal: string | number | null
    let bVal: string | number | null

    if (sort === 'timestamp_utc') {
      aVal = a.timestamp_utc ? new Date(a.timestamp_utc).getTime() : 0
      bVal = b.timestamp_utc ? new Date(b.timestamp_utc).getTime() : 0
    } else if (sort === 'hostname') {
      aVal = a.hostname ?? ''
      bVal = b.hostname ?? ''
    } else if (sort === 'band') {
      aVal = a.band ?? ''
      bVal = b.band ?? ''
    } else if (sort === 'vpn_status') {
      aVal = a.vpn_status ?? ''
      bVal = b.vpn_status ?? ''
    } else if (sort === 'ssid') {
      aVal = a.ssid ?? ''
      bVal = b.ssid ?? ''
    } else {
      aVal = a[sort as 'download_mbps' | 'upload_mbps' | 'latency_ms'] ?? 0
      bVal = b[sort as 'download_mbps' | 'upload_mbps' | 'latency_ms'] ?? 0
    }

    if (aVal < bVal) return order === 'asc' ? -1 : 1
    if (aVal > bVal) return order === 'asc' ? 1 : -1
    return 0
  })

  // Fleet avg: average latest download across devices active in the last 24h
  const since24hMs = Date.now() - 24 * 60 * 60 * 1000
  const activeDevices = (lastPerDevice ?? []).filter(
    (r) => r.timestamp_utc && new Date(r.timestamp_utc).getTime() >= since24hMs && r.download_mbps != null
  )
  const fleetAvg = activeDevices.length > 0
    ? Math.round((activeDevices.reduce((sum, r) => sum + (r.download_mbps ?? 0), 0) / activeDevices.length) * 100) / 100
    : null

  const criticalCount = devices.filter((d) => d.health === 'red').length
  const warningCount  = devices.filter((d) => d.health === 'yellow').length

  return (
    <div className="p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Devices</h1>
          <p className="text-sm text-gray-500 mt-1">
            {devices.length} total
            {criticalCount > 0 && (
              <span className="ml-2 text-red-600 font-medium">· {criticalCount} critical</span>
            )}
            {warningCount > 0 && (
              <span className="ml-2 text-amber-600 font-medium">· {warningCount} warning</span>
            )}
          </p>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        <DeviceTable devices={devices} sort={sort} order={order} fleetAvg={fleetAvg} />
      </div>

      {/* High Jitter Devices */}
      <div className="mt-8 bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-base font-semibold text-gray-900">High Jitter Devices (last 24h)</h2>
        </div>
        <JitterProblemDevices
          devices={jitterStats.topDevices}
          fleetAvg={jitterStats.fleetAvg}
        />
      </div>
    </div>
  )
}
