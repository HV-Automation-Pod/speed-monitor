'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import AlertForm from '@/components/admin/AlertForm'

interface AlertConfig {
  id: number
  name: string
  metric: string | null
  threshold_value: number | null
  scope: string
  scope_device_id: string | null
  enabled: boolean
  created_at: string
}

interface AlertHistoryRow {
  id: number
  device_id: string
  triggered_at: string
  metric_value: number | null
  message: string | null
  config_name: string | null
  threshold_value: number | null
  metric: string | null
}

interface AlertsPageClientProps {
  initialRules: AlertConfig[]
  initialHistory: AlertHistoryRow[]
}

function formatMetric(metric: string | null): string {
  if (metric === 'download_mbps') return 'Download (Mbps)'
  if (metric === 'upload_mbps') return 'Upload (Mbps)'
  if (metric === 'latency_ms') return 'Latency (ms)'
  return metric ?? '—'
}

export default function AlertsPageClient({
  initialRules,
  initialHistory,
}: AlertsPageClientProps) {
  const router = useRouter()
  const [rules, setRules] = useState<AlertConfig[]>(initialRules)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<number | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  async function handleDelete(id: number) {
    setDeletingId(id)
    setDeleteError(null)
    try {
      const res = await fetch('/api/alerts', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error((json as { error?: string }).error ?? 'Failed to delete')
      }
      setRules((prev) => prev.filter((r) => r.id !== id))
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setDeletingId(null)
    }
  }

  async function handleTestAlert(id: number) {
    setTestingId(id)
    setTestError(null)
    try {
      const res = await fetch('/api/alerts/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config_id: id }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        throw new Error((json as { error?: string }).error ?? 'Failed to send test alert')
      }
      // Refresh server component so alert history table shows the new row
      router.refresh()
    } catch (err) {
      setTestError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setTestingId(null)
    }
  }

  function handleSaved() {
    // Refresh server component data (re-fetches initialRules from server)
    router.refresh()
  }

  return (
    <div className="p-8 space-y-10">
      <h1 className="text-2xl font-bold text-gray-900">Alert Rules</h1>

      {/* Section 1: Create Alert Rule */}
      <section>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-4">
            Create Alert Rule
          </h2>
          <AlertForm onSaved={handleSaved} />
        </div>
      </section>

      {/* Section 2: Active Rules */}
      <section>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-base font-semibold text-gray-900">Active Rules</h2>
          </div>

          {(deleteError || testError) && (
            <div className="mx-6 mt-4 px-3 py-2 bg-red-50 border border-red-200 rounded-md text-sm text-red-700">
              {deleteError || testError}
            </div>
          )}

          {rules.length === 0 ? (
            <p className="px-6 py-8 text-center text-gray-400 text-sm">
              No alert rules configured yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-3">Name</th>
                    <th className="px-4 py-3">Metric</th>
                    <th className="px-4 py-3 text-right">Threshold</th>
                    <th className="px-4 py-3">Scope</th>
                    <th className="px-4 py-3">Enabled</th>
                    <th className="px-4 py-3">Created</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {rules.map((rule) => (
                    <tr key={rule.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-medium text-gray-900">
                        {rule.name}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {formatMetric(rule.metric)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-600">
                        {rule.threshold_value != null
                          ? rule.threshold_value.toFixed(1)
                          : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {rule.scope === 'device' && rule.scope_device_id
                          ? `Device: ${rule.scope_device_id}`
                          : 'All devices'}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
                          style={{
                            backgroundColor: rule.enabled ? '#dcfce7' : '#f3f4f6',
                            color: rule.enabled ? '#15803d' : '#6b7280',
                          }}
                        >
                          {rule.enabled ? 'Active' : 'Disabled'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                        {new Date(rule.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-3">
                          <button
                            onClick={() => handleTestAlert(rule.id)}
                            disabled={testingId === rule.id}
                            className="text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50 transition-colors"
                          >
                            {testingId === rule.id ? 'Sending…' : 'Test'}
                          </button>
                          <button
                            onClick={() => handleDelete(rule.id)}
                            disabled={deletingId === rule.id}
                            className="text-xs text-red-600 hover:text-red-800 disabled:opacity-50 transition-colors"
                          >
                            {deletingId === rule.id ? 'Deleting…' : 'Delete'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Section 3: Alert History */}
      <section>
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-base font-semibold text-gray-900">
              Alert History (last 50)
            </h2>
          </div>

          {initialHistory.length === 0 ? (
            <p className="px-6 py-8 text-center text-gray-400 text-sm">
              No alerts have been triggered yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-3">Time</th>
                    <th className="px-4 py-3">Device</th>
                    <th className="px-4 py-3">Metric</th>
                    <th className="px-4 py-3 text-right">Actual Value</th>
                    <th className="px-4 py-3 text-right">Threshold</th>
                    <th className="px-4 py-3">Message</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {initialHistory.map((row) => (
                    <tr key={row.id} className="hover:bg-gray-50">
                      <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                        {new Date(row.triggered_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/devices/${row.device_id}`}
                          className="text-blue-600 hover:underline text-xs font-mono"
                        >
                          {row.device_id}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-gray-600">
                        {formatMetric(row.metric)}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-600">
                        {row.metric_value != null
                          ? row.metric_value.toFixed(1)
                          : '—'}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-gray-600">
                        {row.threshold_value != null
                          ? row.threshold_value.toFixed(1)
                          : '—'}
                      </td>
                      <td className="px-4 py-3 text-gray-600 text-xs max-w-xs truncate">
                        {row.message ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
