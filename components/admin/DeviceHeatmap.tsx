'use client'

import Link from 'next/link'
import { HealthStatus, HEALTH_LABELS } from '@/lib/admin/health'

interface DeviceCell {
  device_id: string
  hostname: string | null
  health: HealthStatus
  last_download: number | null
}

interface DeviceHeatmapProps {
  devices: DeviceCell[]
}

const HEALTH_HEX: Record<HealthStatus, string> = {
  green: '#22c55e',
  yellow: '#facc15',
  red: '#ef4444',
  unknown: '#d1d5db',
}

// Active/assessed devices sort worst-first so problems surface at the top.
const HEALTH_ORDER: Record<HealthStatus, number> = {
  red: 0,
  yellow: 1,
  green: 2,
  unknown: 3,
}

export default function DeviceHeatmap({ devices }: DeviceHeatmapProps) {
  if (devices.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-gray-400 text-sm">
        No devices have reported yet
      </div>
    )
  }

  // 'unknown' here means offline / no data in 24h (active devices have baselines).
  const active = devices
    .filter((d) => d.health !== 'unknown')
    .sort((a, b) => HEALTH_ORDER[a.health] - HEALTH_ORDER[b.health])
  const offline = devices.filter((d) => d.health === 'unknown')

  return (
    <div>
      {/* Active / reporting devices — labeled so you can tell who's who at a glance */}
      {active.length > 0 ? (
        <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 mb-6">
          {active.map((d) => (
            <Link
              key={d.device_id}
              href={`/admin/devices/${d.device_id}`}
              className="flex items-center gap-2.5 rounded-lg border border-gray-100 px-3 py-2 hover:bg-gray-50 transition-colors"
            >
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: HEALTH_HEX[d.health] }}
                title={HEALTH_LABELS[d.health]}
              />
              <span className="text-sm font-medium text-gray-800 truncate">
                {d.hostname ?? <span className="font-mono text-xs text-gray-400">{d.device_id.slice(0, 12)}…</span>}
              </span>
              <span className="ml-auto text-xs text-gray-500 shrink-0 tabular-nums">
                ↓ {d.last_download != null ? d.last_download.toFixed(1) : '—'} Mbps
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-400 mb-6">No devices have reported in the last 24 hours.</p>
      )}

      {/* Offline devices — collapsed to a compact, de-emphasized grid (hover/click to identify) */}
      {offline.length > 0 && (
        <div>
          <p className="text-xs text-gray-400 mb-2">
            {offline.length} device{offline.length !== 1 ? 's' : ''} · no data in last 24h
          </p>
          <div className="grid gap-1 grid-cols-16 md:grid-cols-24 lg:grid-cols-32">
            {offline.map((d) => (
              <Link
                key={d.device_id}
                href={`/admin/devices/${d.device_id}`}
                title={`${d.hostname ?? d.device_id} — no data in 24h`}
                className="h-4 w-full rounded-sm block bg-gray-200 hover:bg-gray-300 transition-colors"
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
