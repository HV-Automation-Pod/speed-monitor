'use client'

import type { HealthStatus } from '@/lib/admin/health'

const HEALTH_HEX: Record<HealthStatus, string> = {
  green:   '#22c55e',
  yellow:  '#facc15',
  red:     '#ef4444',
  unknown: '#d1d5db',
}

// Employee-specific copy — different from admin HEALTH_LABELS
const HEALTH_LABELS: Record<HealthStatus, string> = {
  green:   'Good — Your connection is performing normally',
  yellow:  'Degraded — Slower than usual, check recommendations below',
  red:     'Poor — Contact IT support',
  unknown: 'No recent data — Make sure the Speed Monitor app is running',
}

export default function HealthBadge({ health }: { health: HealthStatus }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className="inline-block w-4 h-4 rounded-full flex-shrink-0"
        style={{ backgroundColor: HEALTH_HEX[health] }}
        aria-hidden="true"
      />
      <span className="text-base font-medium text-gray-900">
        {HEALTH_LABELS[health]}
      </span>
    </div>
  )
}
