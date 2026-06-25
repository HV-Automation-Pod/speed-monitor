import { supabaseAdmin } from '@/lib/supabase/admin'
import { isScoped, ALL_SSIDS } from '@/lib/admin/ssid'
import { resolveSsid, getAvailableSsids } from '@/lib/admin/ssid-server'
import { VpnImpactRow, SsidRow, DowRow } from '@/lib/analytics/types'
import VpnImpactTable from '@/components/admin/VpnImpactTable'
import SsidBarChart from '@/components/admin/SsidBarChart'
import DowBarChart from '@/components/admin/DowBarChart'
import SsidFilter from '@/components/admin/SsidFilter'

export const dynamic = 'force-dynamic'

async function getVpnImpactData(ssid: string): Promise<VpnImpactRow[]> {
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  let query = supabaseAdmin
    .from('speed_results')
    .select('device_id, hostname, vpn_status, download_mbps, upload_mbps, latency_ms')
    .gte('timestamp_utc', since30d)
    .not('vpn_status', 'is', null)
    .limit(50000)
  if (isScoped(ssid)) query = query.eq('ssid', ssid)
  const { data } = await query

  const rows = data ?? []

  interface DeviceVpnBucket {
    hostname: string | null
    connected: { sumDown: number; sumUp: number; sumLat: number; count: number }
    disconnected: { sumDown: number; sumUp: number; sumLat: number; count: number }
  }

  const byDevice = new Map<string, DeviceVpnBucket>()

  for (const row of rows) {
    if (row.vpn_status !== 'connected' && row.vpn_status !== 'disconnected') continue

    const existing = byDevice.get(row.device_id) ?? {
      hostname: row.hostname ?? null,
      connected: { sumDown: 0, sumUp: 0, sumLat: 0, count: 0 },
      disconnected: { sumDown: 0, sumUp: 0, sumLat: 0, count: 0 },
    }

    const bucket = existing[row.vpn_status as 'connected' | 'disconnected']
    if (row.download_mbps != null) bucket.sumDown += row.download_mbps
    if (row.upload_mbps != null) bucket.sumUp += row.upload_mbps
    if (row.latency_ms != null) bucket.sumLat += row.latency_ms
    bucket.count++

    byDevice.set(row.device_id, existing)
  }

  const avgOrNull = (sum: number, count: number) =>
    count > 0 ? Math.round((sum / count) * 100) / 100 : null

  const result: VpnImpactRow[] = []

  for (const [device_id, b] of byDevice) {
    const onDown = avgOrNull(b.connected.sumDown, b.connected.count)
    const onUp = avgOrNull(b.connected.sumUp, b.connected.count)
    const onLat = avgOrNull(b.connected.sumLat, b.connected.count)
    const offDown = avgOrNull(b.disconnected.sumDown, b.disconnected.count)
    const offUp = avgOrNull(b.disconnected.sumUp, b.disconnected.count)
    const offLat = avgOrNull(b.disconnected.sumLat, b.disconnected.count)

    if (onDown == null && offDown == null) continue

    const deltaDownload =
      onDown != null && offDown != null
        ? Math.round((offDown - onDown) * 100) / 100
        : null

    result.push({
      device_id,
      hostname: b.hostname,
      on_download: onDown,
      on_upload: onUp,
      on_latency: onLat,
      off_download: offDown,
      off_upload: offUp,
      off_latency: offLat,
      delta_download: deltaDownload,
    })
  }

  result.sort((a, b) => {
    if (a.delta_download == null && b.delta_download == null) return 0
    if (a.delta_download == null) return 1
    if (b.delta_download == null) return -1
    return b.delta_download - a.delta_download
  })

  return result
}

async function getSsidData(): Promise<SsidRow[]> {
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const { data } = await supabaseAdmin
    .from('speed_results')
    .select('device_id, ssid, download_mbps, upload_mbps, latency_ms')
    .gte('timestamp_utc', since30d)
    .not('ssid', 'is', null)
    .limit(50000)

  const rows = data ?? []

  interface SsidBucket {
    deviceIds: Set<string>
    sumDown: number
    downCount: number
    sumUp: number
    upCount: number
    sumLat: number
    latCount: number
  }

  const bySsid = new Map<string, SsidBucket>()

  for (const row of rows) {
    if (!row.ssid) continue

    const existing = bySsid.get(row.ssid) ?? {
      deviceIds: new Set<string>(),
      sumDown: 0,
      downCount: 0,
      sumUp: 0,
      upCount: 0,
      sumLat: 0,
      latCount: 0,
    }

    existing.deviceIds.add(row.device_id)
    if (row.download_mbps != null) { existing.sumDown += row.download_mbps; existing.downCount++ }
    if (row.upload_mbps != null) { existing.sumUp += row.upload_mbps; existing.upCount++ }
    if (row.latency_ms != null) { existing.sumLat += row.latency_ms; existing.latCount++ }

    bySsid.set(row.ssid, existing)
  }

  const result: SsidRow[] = Array.from(bySsid.entries()).map(([ssid, b]) => ({
    ssid,
    device_count: b.deviceIds.size,
    avg_download: b.downCount > 0 ? Math.round((b.sumDown / b.downCount) * 100) / 100 : null,
    avg_upload:   b.upCount   > 0 ? Math.round((b.sumUp   / b.upCount  ) * 100) / 100 : null,
    avg_latency:  b.latCount  > 0 ? Math.round((b.sumLat  / b.latCount ) * 100) / 100 : null,
  }))

  result.sort((a, b) => {
    if (a.avg_download == null && b.avg_download == null) return 0
    if (a.avg_download == null) return 1
    if (b.avg_download == null) return -1
    return b.avg_download - a.avg_download
  })

  return result
}

async function getDowData(ssid: string): Promise<DowRow[]> {
  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  let query = supabaseAdmin
    .from('speed_results')
    .select('timestamp_utc, download_mbps')
    .gte('timestamp_utc', since30d)
    .not('download_mbps', 'is', null)
    .limit(50000)
  if (isScoped(ssid)) query = query.eq('ssid', ssid)
  const { data } = await query

  const rows = data ?? []

  const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const byDow = new Map<number, { sum: number; count: number }>()

  for (const row of rows) {
    if (row.timestamp_utc == null || row.download_mbps == null) continue
    // Bucket by IST day — a 00:00-05:30 IST sample is the previous day in UTC,
    // which would mislabel weekday performance for an India fleet.
    const istMs = new Date(row.timestamp_utc).getTime() + 5.5 * 3_600_000
    const dow = new Date(istMs).getUTCDay()
    const entry = byDow.get(dow) ?? { sum: 0, count: 0 }
    entry.sum += row.download_mbps
    entry.count++
    byDow.set(dow, entry)
  }

  const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0]
  return DOW_ORDER.map(dow => ({
    day: DOW_LABELS[dow],
    avg_download: byDow.has(dow) && byDow.get(dow)!.count > 0
      ? Math.round((byDow.get(dow)!.sum / byDow.get(dow)!.count) * 100) / 100
      : null,
  }))
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ ssid?: string }>
}) {
  const ssid = await resolveSsid((await searchParams).ssid)
  const scopeLabel = ssid === ALL_SSIDS ? 'all networks' : ssid

  const [vpnImpact, ssidRows, dowRows, ssidOptions] = await Promise.all([
    getVpnImpactData(ssid),
    getSsidData(), // cross-network by design (it IS the SSID comparison)
    getDowData(ssid),
    getAvailableSsids(),
  ])

  return (
    <div className="p-8">
      {/* Page header */}
      <div className="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
          <p className="text-sm text-gray-500 mt-1">
            80/20 network insights · last 30 days · <span className="font-medium text-gray-700">{scopeLabel}</span>
          </p>
        </div>
        <SsidFilter current={ssid} options={ssidOptions} />
      </div>

      {/* VPN Impact section */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 mb-6">
        <h2 className="text-base font-semibold text-gray-900 mb-1">VPN Speed Impact</h2>
        <p className="text-xs text-gray-400 mb-4">Per-device avg speed when VPN on vs off · 30-day window</p>
        <VpnImpactTable rows={vpnImpact} />
      </div>

      {/* SSID Comparison section */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 mb-6">
        <h2 className="text-base font-semibold text-gray-900 mb-1">SSID Performance Comparison</h2>
        <p className="text-xs text-gray-400 mb-4">Avg speed per network · 30-day window · sorted by download</p>
        <SsidBarChart rows={ssidRows} />
      </div>

      {/* Day-of-Week section */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-6 mb-6">
        <h2 className="text-base font-semibold text-gray-900 mb-1">Day-of-Week Performance</h2>
        <p className="text-xs text-gray-400 mb-4">Fleet avg download by day · 30-day window · IST days</p>
        <DowBarChart rows={dowRows} />
      </div>
    </div>
  )
}
