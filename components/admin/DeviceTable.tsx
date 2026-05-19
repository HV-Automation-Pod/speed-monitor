'use client'

import { useState, useMemo, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { HealthStatus, HEALTH_LABELS } from '@/lib/admin/health'

export interface DeviceRow {
  device_id: string
  hostname: string | null
  health: HealthStatus
  download_mbps: number | null
  upload_mbps: number | null
  latency_ms: number | null
  timestamp_utc: string | null
  band: string | null
  vpn_status: string | null
  ssid: string | null
  user_email: string | null
}

interface DeviceTableProps {
  devices: DeviceRow[]
  sort: string
  order: string
  fleetAvg?: number | null  // fleet 24h avg download Mbps — optional, column hidden when null
}

const HEALTH_HEX: Record<HealthStatus, string> = {
  green:   '#22c55e',
  yellow:  '#facc15',
  red:     '#ef4444',
  unknown: '#d1d5db',
}
const HEALTH_TEXT: Record<HealthStatus, string> = {
  green:   '#166534',
  yellow:  '#854d0e',
  red:     '#991b1b',
  unknown: '#6b7280',
}
const HEALTH_BG: Record<HealthStatus, string> = {
  green:   '#f0fdf4',
  yellow:  '#fefce8',
  red:     '#fef2f2',
  unknown: '#f9fafb',
}

type FilterHealth = HealthStatus | 'all'

function relativeTime(isoString: string | null): string {
  if (!isoString) return 'Never'
  const diff = Date.now() - new Date(isoString).getTime()
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

const SORTABLE_COLUMNS: Array<{ key: string; label: string; align?: 'right' }> = [
  { key: 'hostname',      label: 'Device' },
  { key: 'health',        label: 'Health' },
  { key: 'last_seen',     label: 'Last Seen' },
  { key: 'download_mbps', label: 'Download', align: 'right' },
  { key: 'upload_mbps',   label: 'Upload',   align: 'right' },
  { key: 'latency_ms',    label: 'Latency',  align: 'right' },
  { key: 'band',          label: 'Band' },
  { key: 'ssid',          label: 'SSID' },
  { key: 'vpn_status',    label: 'VPN' },
]

function SortIcon({ active, order }: { active: boolean; order: string }) {
  if (!active) {
    return (
      <svg className="w-3 h-3 text-gray-300 inline ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
      </svg>
    )
  }
  return order === 'asc' ? (
    <svg className="w-3 h-3 text-indigo-500 inline ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
    </svg>
  ) : (
    <svg className="w-3 h-3 text-indigo-500 inline ml-1" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  )
}

function DeleteButton({ deviceId, hostname }: { deviceId: string; hostname: string | null }) {
  const router = useRouter()
  const [confirming, setConfirming] = useState(false)
  const [isPending, startTransition] = useTransition()

  function handleFirstClick(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    setConfirming(true)
    // Auto-cancel confirmation after 4 seconds
    setTimeout(() => setConfirming(false), 4000)
  }

  function handleConfirm(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    startTransition(async () => {
      await fetch(`/api/devices/${deviceId}`, { method: 'DELETE' })
      router.refresh()
    })
  }

  function handleCancel(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    setConfirming(false)
  }

  if (isPending) {
    return <span className="text-xs text-gray-400">Deleting…</span>
  }

  if (confirming) {
    return (
      <span className="inline-flex items-center gap-1">
        <button
          onClick={handleConfirm}
          className="text-xs font-medium text-white bg-red-600 hover:bg-red-700 px-2 py-0.5 rounded transition-colors"
        >
          Delete
        </button>
        <button
          onClick={handleCancel}
          className="text-xs text-gray-500 hover:text-gray-700 px-1"
        >
          Cancel
        </button>
      </span>
    )
  }

  return (
    <button
      onClick={handleFirstClick}
      title={`Delete ${hostname ?? deviceId}`}
      className="text-gray-300 hover:text-red-500 transition-colors"
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
      </svg>
    </button>
  )
}

export default function DeviceTable({ devices, sort, order, fleetAvg = null }: DeviceTableProps) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [healthFilter, setHealthFilter] = useState<FilterHealth>('all')
  const [ssidFilter, setSsidFilter] = useState<string>('all')

  // Unique SSIDs for the dropdown
  const ssidOptions = useMemo(() => {
    const set = new Set<string>()
    for (const d of devices) {
      if (d.ssid) set.add(d.ssid)
    }
    return Array.from(set).sort()
  }, [devices])

  // Count per health status for filter pills
  const healthCounts = useMemo(() => {
    const counts: Record<FilterHealth, number> = { all: devices.length, green: 0, yellow: 0, red: 0, unknown: 0 }
    for (const d of devices) counts[d.health]++
    return counts
  }, [devices])

  // Apply search + health + SSID filter client-side
  const filtered = useMemo(() => {
    return devices.filter((d) => {
      if (healthFilter !== 'all' && d.health !== healthFilter) return false
      if (ssidFilter !== 'all' && d.ssid !== ssidFilter) return false
      if (search.trim()) {
        const q = search.trim().toLowerCase()
        const name = (d.hostname ?? d.device_id).toLowerCase()
        const email = (d.user_email ?? '').toLowerCase()
        if (!name.includes(q) && !email.includes(q)) return false
      }
      return true
    })
  }, [devices, search, healthFilter, ssidFilter])

  function handleSort(column: string) {
    const newOrder = sort === column && order === 'desc' ? 'asc' : 'desc'
    router.push(`/admin/devices?sort=${column}&order=${newOrder}`)
  }

  const FILTER_PILLS: Array<{ key: FilterHealth; label: string; dot?: string }> = [
    { key: 'all',     label: 'All' },
    { key: 'red',     label: 'Critical', dot: '#ef4444' },
    { key: 'yellow',  label: 'Warning',  dot: '#facc15' },
    { key: 'green',   label: 'Healthy',  dot: '#22c55e' },
    { key: 'unknown', label: 'Unknown',  dot: '#d1d5db' },
  ]

  return (
    <div>
      {/* Search + filter bar */}
      <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center gap-3">
        {/* Search */}
        <div className="relative flex-1 min-w-48 max-w-xs">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-sm border border-gray-200 rounded-lg bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Health filter pills */}
        <div className="flex items-center gap-1.5">
          {FILTER_PILLS.map(({ key, label, dot }) => {
            const active = healthFilter === key
            return (
              <button
                key={key}
                onClick={() => setHealthFilter(key)}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                  active
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                {dot && (
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: active ? 'white' : dot }} />
                )}
                {label}
                <span className={`${active ? 'opacity-75' : 'text-gray-400'}`}>
                  {healthCounts[key]}
                </span>
              </button>
            )
          })}
        </div>

        {/* SSID filter dropdown */}
        {ssidOptions.length > 0 && (
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.14 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
            </svg>
            <select
              value={ssidFilter}
              onChange={(e) => setSsidFilter(e.target.value)}
              className="pl-7 pr-7 py-1.5 text-xs border border-gray-200 rounded-lg bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent appearance-none cursor-pointer text-gray-700"
            >
              <option value="all">All SSIDs</option>
              {ssidOptions.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <svg className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </div>
        )}

        {/* Result count when filtered */}
        {(search || healthFilter !== 'all' || ssidFilter !== 'all') && (
          <span className="text-xs text-gray-400 ml-auto">
            {filtered.length} of {devices.length}
          </span>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <svg className="w-8 h-8 text-gray-300 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <p className="text-sm font-medium text-gray-500">No devices match your filters</p>
          <button
            onClick={() => { setSearch(''); setHealthFilter('all'); setSsidFilter('all') }}
            className="mt-2 text-xs text-indigo-600 hover:underline"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                {SORTABLE_COLUMNS.map(({ key, label, align }) => (
                  <th
                    key={key}
                    onClick={() => handleSort(key)}
                    className={`px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide cursor-pointer hover:text-gray-900 select-none whitespace-nowrap ${align === 'right' ? 'text-right' : ''}`}
                  >
                    {label}
                    <SortIcon active={sort === key} order={order} />
                  </th>
                ))}
                {fleetAvg != null && (
                  <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    vs Fleet
                  </th>
                )}
                <th className="px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-20">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.map((device) => (
                <tr
                  key={device.device_id}
                  className="hover:bg-gray-50 transition-colors group"
                >
                  {/* Device name */}
                  <td className="px-4 py-3">
                    <Link href={`/admin/devices/${device.device_id}`} className="block">
                      <span className="font-medium text-gray-900 group-hover:text-indigo-600 transition-colors">
                        {device.hostname ?? (
                          <span className="font-mono text-xs text-gray-400">
                            {device.device_id.slice(0, 12)}…
                          </span>
                        )}
                      </span>
                      {device.user_email && (
                        <span className="block text-xs text-gray-400 mt-0.5">
                          {device.user_email}
                        </span>
                      )}
                    </Link>
                  </td>

                  {/* Health badge */}
                  <td className="px-4 py-3">
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
                      style={{
                        backgroundColor: HEALTH_BG[device.health],
                        color: HEALTH_TEXT[device.health],
                        border: `1px solid ${HEALTH_HEX[device.health]}40`,
                      }}
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full shrink-0"
                        style={{ backgroundColor: HEALTH_HEX[device.health] }}
                      />
                      {HEALTH_LABELS[device.health]}
                    </span>
                  </td>

                  {/* Last seen */}
                  <td className="px-4 py-3 text-gray-500 whitespace-nowrap text-xs">
                    {relativeTime(device.timestamp_utc)}
                  </td>

                  {/* Download */}
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                    {device.download_mbps != null
                      ? <><span className="font-medium">{device.download_mbps.toFixed(1)}</span><span className="text-gray-400 text-xs ml-0.5">Mbps</span></>
                      : <span className="text-gray-300">—</span>}
                  </td>

                  {/* Upload */}
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                    {device.upload_mbps != null
                      ? <><span className="font-medium">{device.upload_mbps.toFixed(1)}</span><span className="text-gray-400 text-xs ml-0.5">Mbps</span></>
                      : <span className="text-gray-300">—</span>}
                  </td>

                  {/* Latency */}
                  <td className="px-4 py-3 text-right tabular-nums text-gray-700">
                    {device.latency_ms != null
                      ? <><span className="font-medium">{device.latency_ms.toFixed(0)}</span><span className="text-gray-400 text-xs ml-0.5">ms</span></>
                      : <span className="text-gray-300">—</span>}
                  </td>

                  {/* Band */}
                  <td className="px-4 py-3 text-xs text-gray-600">
                    {device.band ? (
                      <span className="px-1.5 py-0.5 bg-gray-100 rounded font-medium">{device.band}</span>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>

                  {/* SSID */}
                  <td className="px-4 py-3 text-xs text-gray-600 max-w-[140px]">
                    {device.ssid ? (
                      <button
                        onClick={() => setSsidFilter(ssidFilter === device.ssid ? 'all' : device.ssid!)}
                        title={`Filter by ${device.ssid}`}
                        className={`px-1.5 py-0.5 rounded font-medium truncate max-w-full block transition-colors ${
                          ssidFilter === device.ssid
                            ? 'bg-indigo-100 text-indigo-700'
                            : 'bg-gray-100 text-gray-600 hover:bg-indigo-50 hover:text-indigo-600'
                        }`}
                      >
                        {device.ssid}
                      </button>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>

                  {/* VPN */}
                  <td className="px-4 py-3">
                    {device.vpn_status == null ? (
                      <span className="text-gray-300 text-xs">—</span>
                    ) : device.vpn_status === 'active' ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                        On
                      </span>
                    ) : (
                      <span className="text-xs text-gray-400 capitalize">{device.vpn_status}</span>
                    )}
                  </td>

                  {/* vs Fleet */}
                  {fleetAvg != null && (
                    <td className="px-3 py-3 text-right tabular-nums text-xs font-medium whitespace-nowrap">
                      {(() => {
                        const dl = device.download_mbps
                        if (dl == null || fleetAvg === 0) return <span className="text-gray-400">—</span>
                        const pct = Math.round(((dl - fleetAvg) / fleetAvg) * 100)
                        const isAbove = pct >= 0
                        return (
                          <span style={{ color: isAbove ? '#15803d' : '#b91c1c' }}>
                            {isAbove ? '+' : ''}{pct}%
                          </span>
                        )
                      })()}
                    </td>
                  )}

                  {/* Actions */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <Link
                        href={`/admin/devices/${device.device_id}`}
                        className="text-xs font-medium text-indigo-600 hover:text-indigo-800"
                      >
                        View
                      </Link>
                      <DeleteButton deviceId={device.device_id} hostname={device.hostname} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
