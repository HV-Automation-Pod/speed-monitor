import Link from 'next/link'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { computeHealthStatus, HealthStatus } from '@/lib/admin/health'
import { isScoped, ALL_SSIDS } from '@/lib/admin/ssid'
import { resolveSsid, getAvailableSsids } from '@/lib/admin/ssid-server'
import StatCard from '@/components/admin/StatCard'
import DeviceHeatmap from '@/components/admin/DeviceHeatmap'
import HealthSummaryStrip from '@/components/admin/HealthSummaryStrip'
import Sparkline from '@/components/admin/Sparkline'
import SsidFilter from '@/components/admin/SsidFilter'

export const dynamic = 'force-dynamic'

interface DeviceCell {
  device_id: string
  hostname: string | null
  health: HealthStatus
  last_download: number | null
}

async function getFleetStats(ssid: string) {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  let query = supabaseAdmin
    .from('speed_results')
    .select('device_id, download_mbps, upload_mbps, latency_ms')
    .gte('timestamp_utc', since24h)
  if (isScoped(ssid)) query = query.eq('ssid', ssid)
  const { data } = await query

  const rows = data ?? []
  const deviceIds = new Set(rows.map((r) => r.device_id))
  const activeDeviceCount = deviceIds.size

  const downloads = rows.map((r) => r.download_mbps).filter((v): v is number => v != null)
  const uploads   = rows.map((r) => r.upload_mbps).filter((v): v is number => v != null)
  const latencies = rows.map((r) => r.latency_ms).filter((v): v is number => v != null)

  const avg = (arr: number[]) =>
    arr.length > 0 ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 100) / 100 : 0

  return {
    activeDeviceCount,
    avgDownload: avg(downloads),
    avgUpload: avg(uploads),
    avgLatency: avg(latencies),
  }
}

async function getDevicesForHeatmap(ssid: string): Promise<DeviceCell[]> {
  type LatestRow = {
    device_id: string
    hostname: string | null
    download_mbps: number | null
    timestamp_utc: string | null
  }

  // "All networks" → DISTINCT-ON RPC (latest result per device, any network),
  // matching the Devices page. A specific network → latest result per device
  // ON that SSID (the RPC has no ssid arg), deduped from a filtered query —
  // the single-SSID result set is small, so this never truncates.
  const baselinesPromise = supabaseAdmin
    .from('device_baselines')
    .select('device_id, mean, std_dev')
    .eq('metric', 'download_mbps')

  let lastPerDevice: LatestRow[]
  if (isScoped(ssid)) {
    const { data } = await supabaseAdmin
      .from('speed_results')
      .select('device_id, hostname, download_mbps, timestamp_utc')
      .eq('ssid', ssid)
      .order('timestamp_utc', { ascending: false })
      .limit(5000)
    const seen = new Set<string>()
    lastPerDevice = []
    for (const row of (data as LatestRow[] | null) ?? []) {
      if (!seen.has(row.device_id)) {
        seen.add(row.device_id)
        lastPerDevice.push(row)
      }
    }
  } else {
    const { data } = await supabaseAdmin.rpc('get_latest_per_device')
    lastPerDevice = (data as LatestRow[] | null) ?? []
  }

  const { data: baselines } = await baselinesPromise
  const baselineMap = new Map((baselines ?? []).map((b) => [b.device_id, b]))

  return lastPerDevice.map((r) => {
    const baseline = baselineMap.get(r.device_id)
    const health = computeHealthStatus(
      r.download_mbps,
      baseline?.mean ?? null,
      baseline?.std_dev ?? null,
      r.timestamp_utc,
    )
    return { device_id: r.device_id, hostname: r.hostname, health, last_download: r.download_mbps }
  })
}

async function getFleetSparkline(ssid: string): Promise<{ value: number }[]> {
  const windowStart = Date.now() - 24 * 60 * 60 * 1000
  let query = supabaseAdmin
    .from('speed_results')
    .select('timestamp_utc, download_mbps')
    .gte('timestamp_utc', new Date(windowStart).toISOString())
    .order('timestamp_utc', { ascending: true })
  if (isScoped(ssid)) query = query.eq('ssid', ssid)
  const { data } = await query

  const rows = (data ?? []).filter(r => r.download_mbps != null)
  // 24 hourly buckets indexed by ELAPSED hours within the rolling window
  // (bucket 0 = oldest, 23 = most recent) → strictly chronological, and
  // timezone-independent. (Previously indexed by absolute UTC hour 0-23, which
  // scrambled the order across a midnight boundary.)
  const buckets: number[][] = Array.from({ length: 24 }, () => [])
  for (const row of rows) {
    const elapsedH = Math.floor((new Date(row.timestamp_utc as string).getTime() - windowStart) / 3_600_000)
    const idx = Math.min(23, Math.max(0, elapsedH))
    buckets[idx].push(row.download_mbps as number)
  }
  return buckets.map(b =>
    b.length > 0 ? { value: Math.round((b.reduce((a, c) => a + c, 0) / b.length) * 10) / 10 } : { value: 0 }
  )
}

function relativeTime(isoString: string | null): string {
  if (!isoString) return 'Never'
  const diff = Date.now() - new Date(isoString).getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<{ ssid?: string }>
}) {
  const ssid = await resolveSsid((await searchParams).ssid)
  const scopeLabel = ssid === ALL_SSIDS ? 'all networks' : ssid

  const [stats, devices, sparklineData, ssidOptions] = await Promise.all([
    getFleetStats(ssid),
    getDevicesForHeatmap(ssid),
    getFleetSparkline(ssid),
    getAvailableSsids(),
  ])

  const healthCounts = {
    critical: devices.filter(d => d.health === 'red').length,
    warning:  devices.filter(d => d.health === 'yellow').length,
    healthy:  devices.filter(d => d.health === 'green').length,
    unknown:  devices.filter(d => d.health === 'unknown').length,
    total:    devices.length,
  }

  return (
    <div className="p-8">
      {/* Page header */}
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Fleet Overview</h1>
          <p className="text-sm text-gray-500 mt-1">
            Network performance · last 24 hours · <span className="font-medium text-gray-700">{scopeLabel}</span>
          </p>
        </div>
        <SsidFilter current={ssid} options={ssidOptions} />
      </div>

      {/* Health summary strip */}
      <div className="mb-6">
        <HealthSummaryStrip
          critical={healthCounts.critical}
          warning={healthCounts.warning}
          healthy={healthCounts.healthy}
          unknown={healthCounts.unknown}
          total={healthCounts.total}
        />
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Active Devices"
          value={stats.activeDeviceCount}
          sublabel="last 24 hours"
          accent="bg-indigo-500"
          icon={
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
            </svg>
          }
        />
        <StatCard
          label="Avg Download"
          value={stats.avgDownload}
          unit="Mbps"
          sublabel="last 24 hours"
          accent="bg-emerald-500"
          icon={
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
          }
        />
        <StatCard
          label="Avg Upload"
          value={stats.avgUpload}
          unit="Mbps"
          sublabel="last 24 hours"
          accent="bg-sky-500"
          icon={
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 10l7-7m0 0l7 7m-7-7v18" />
            </svg>
          }
        />
        <StatCard
          label="Avg Latency"
          value={stats.avgLatency}
          unit="ms"
          sublabel="last 24 hours"
          accent="bg-amber-500"
          icon={
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
      </div>

      {/* 24h Fleet Download Trend */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-5 pt-4 pb-3 mb-8">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-medium text-gray-600">Fleet Avg Download — last 24 hours</p>
          <p className="text-xs text-gray-400">hourly avg · Mbps</p>
        </div>
        <Sparkline data={sparklineData} color="#6366f1" />
      </div>

      {/* Needs Attention */}
      {(() => {
        const problems = devices.filter((d) => d.health === 'red' || d.health === 'yellow')
        if (problems.length === 0) return null
        return (
          <div className="mb-8 bg-white rounded-xl shadow-sm border border-amber-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-amber-100 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <h2 className="text-sm font-semibold text-gray-900">Needs Attention</h2>
                <span className="text-xs text-amber-600 font-medium bg-amber-50 px-2 py-0.5 rounded-full">{problems.length} device{problems.length !== 1 ? 's' : ''}</span>
              </div>
              <Link href="/admin/devices" className="text-xs text-indigo-600 hover:underline">View all →</Link>
            </div>
            <div className="divide-y divide-gray-50">
              {problems.slice(0, 5).map((d) => (
                <Link
                  key={d.device_id}
                  href={`/admin/devices/${d.device_id}`}
                  className="flex items-center justify-between px-6 py-3 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: d.health === 'red' ? '#ef4444' : '#facc15' }}
                    />
                    <span className="text-sm font-medium text-gray-900">
                      {d.hostname ?? <span className="font-mono text-xs text-gray-400">{d.device_id.slice(0, 12)}…</span>}
                    </span>
                  </div>
                  <div className="flex items-center gap-6 text-xs text-gray-500">
                    {d.last_download != null && (
                      <span>↓ <strong className="text-gray-700">{d.last_download.toFixed(1)}</strong> Mbps</span>
                    )}
                    <span className="text-gray-400">
                      {d.health === 'red' ? '⚠ Critical' : '⚡ Warning'}
                    </span>
                  </div>
                </Link>
              ))}
              {problems.length > 5 && (
                <div className="px-6 py-3 text-xs text-gray-400 text-center">
                  +{problems.length - 5} more — <Link href="/admin/devices" className="text-indigo-600 hover:underline">see all</Link>
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* Device health heatmap */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="text-base font-semibold text-gray-900 mb-1">Device Health</h2>
        <p className="text-xs text-gray-400 mb-4">Last result per device</p>
        <DeviceHeatmap devices={devices} />
      </div>
    </div>
  )
}
