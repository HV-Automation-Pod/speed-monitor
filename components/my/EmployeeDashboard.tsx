'use client'

import { useState } from 'react'
import DeviceSpeedChart from '@/components/admin/DeviceSpeedChart'
import HealthBadge from '@/components/my/HealthBadge'
import ShareButton from '@/components/my/ShareButton'
import type { HealthStatus } from '@/lib/admin/health'

interface SpeedResult {
  timestamp_utc: string
  download_mbps: number | null
  upload_mbps: number | null
  latency_ms: number | null
  ssid: string | null
  vpn_active: boolean | null
  hostname: string | null
  [key: string]: unknown
}

interface ChartPoint {
  timestamp_utc: string
  download_mbps: number | null
  upload_mbps: number | null
}

interface Props {
  deviceId: string
  hostname: string | null
  health: HealthStatus
  lastTest: SpeedResult | null
  chart24hData: ChartPoint[]
  last10Tests: SpeedResult[]
  recommendations: string[]
  /** Optional network-scope selector (rendered by the server page). */
  ssidFilter?: React.ReactNode
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function Section({
  title,
  defaultOpen = false,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="border border-gray-200 rounded-xl bg-white overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-gray-50 transition-colors"
      >
        <span className="font-medium text-gray-900">{title}</span>
        <span className="text-gray-400 text-sm">{open ? '▲' : '▼'}</span>
      </button>
      {open && <div className="px-5 pb-5">{children}</div>}
    </div>
  )
}

// Filter out the "healthy" fallback string — only show actual issue recommendations
function hasRealRecommendations(recs: string[]): boolean {
  return recs.length > 0 && !recs[0].startsWith('Connection looks healthy')
}

export default function EmployeeDashboard({
  deviceId,
  hostname,
  health,
  lastTest,
  chart24hData,
  last10Tests,
  recommendations,
  ssidFilter,
}: Props) {
  const showRecommendations = hasRealRecommendations(recommendations)

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">
            {hostname ?? deviceId}
          </h1>
          {hostname && (
            <p className="text-sm text-gray-500 mt-0.5">{deviceId}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {ssidFilter}
          <ShareButton deviceId={deviceId} />
        </div>
      </div>

      {/* Health + key stats — always visible */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
        <HealthBadge health={health} />
        {lastTest && (
          <div className="grid grid-cols-3 gap-4 pt-2 border-t border-gray-100">
            <div>
              <p className="text-xs text-gray-500">Download</p>
              <p className="text-lg font-semibold text-gray-900">
                {lastTest.download_mbps != null ? `${lastTest.download_mbps.toFixed(1)} Mbps` : '—'}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Upload</p>
              <p className="text-lg font-semibold text-gray-900">
                {lastTest.upload_mbps != null ? `${lastTest.upload_mbps.toFixed(1)} Mbps` : '—'}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500">Latency</p>
              <p className="text-lg font-semibold text-gray-900">
                {lastTest.latency_ms != null ? `${Math.round(lastTest.latency_ms)} ms` : '—'}
              </p>
            </div>
          </div>
        )}
        {lastTest && (
          <p className="text-xs text-gray-400">
            Last test: {formatDate(lastTest.timestamp_utc)}
          </p>
        )}
      </div>

      {/* Recommendations — hero content, default open if there are issues */}
      {showRecommendations ? (
        <Section title={`Recommendations (${recommendations.length})`} defaultOpen={true}>
          <ul className="space-y-3 pt-1">
            {recommendations.map((rec, i) => (
              <li key={i} className="flex gap-3">
                <span className="text-orange-500 mt-0.5 flex-shrink-0">&#9888;</span>
                <p className="text-gray-700 text-sm">{rec}</p>
              </li>
            ))}
          </ul>
        </Section>
      ) : (
        <div className="bg-green-50 border border-green-200 rounded-xl px-5 py-4">
          <p className="text-green-800 text-sm font-medium">
            &#10003; No issues detected — your connection looks healthy
          </p>
        </div>
      )}

      {/* 24-hour chart — collapsible */}
      <Section title="24-hour speed history" defaultOpen={false}>
        <div className="pt-2">
          {chart24hData.length > 0 ? (
            <DeviceSpeedChart data24h={chart24hData} data7d={[]} />
          ) : (
            <p className="text-gray-500 text-sm py-4 text-center">
              No data in the last 24 hours
            </p>
          )}
        </div>
      </Section>

      {/* Last 10 tests table — collapsible */}
      <Section title="Recent tests" defaultOpen={false}>
        {last10Tests.length > 0 ? (
          <div className="overflow-x-auto pt-1">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 text-xs border-b border-gray-100">
                  <th className="pb-2 font-medium">Time</th>
                  <th className="pb-2 font-medium">Down</th>
                  <th className="pb-2 font-medium">Up</th>
                  <th className="pb-2 font-medium">Latency</th>
                  <th className="pb-2 font-medium">WiFi</th>
                  <th className="pb-2 font-medium">VPN</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {last10Tests.map((t, i) => (
                  <tr key={i} className="text-gray-700">
                    <td className="py-2 text-xs text-gray-500">{formatDate(t.timestamp_utc)}</td>
                    <td className="py-2">{t.download_mbps != null ? `${t.download_mbps.toFixed(1)}` : '—'}</td>
                    <td className="py-2">{t.upload_mbps != null ? `${t.upload_mbps.toFixed(1)}` : '—'}</td>
                    <td className="py-2">{t.latency_ms != null ? `${Math.round(t.latency_ms)}ms` : '—'}</td>
                    <td className="py-2 text-xs">{t.ssid ?? '—'}</td>
                    <td className="py-2">
                      <span className={t.vpn_active ? 'text-green-600' : 'text-gray-400'}>
                        {t.vpn_active ? 'On' : 'Off'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-gray-500 text-sm py-4 text-center">No recent tests</p>
        )}
      </Section>
    </div>
  )
}
