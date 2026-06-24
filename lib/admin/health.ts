export type HealthStatus = 'green' | 'yellow' | 'red' | 'unknown'

export function computeHealthStatus(
  lastDownload: number | null,
  baselineMean: number | null,
  baselineStdDev: number | null,
  lastSeenAt: string | null,
): HealthStatus {
  // Offline / no recent data is NOT "Critical" — it's simply unassessable.
  // (Critical is reserved for devices that ARE reporting but performing badly.)
  if (!lastSeenAt) return 'unknown'
  const hoursSinceLastSeen = (Date.now() - new Date(lastSeenAt).getTime()) / 3_600_000
  if (hoursSinceLastSeen > 24) return 'unknown'
  if (baselineMean == null || baselineStdDev == null || lastDownload == null) return 'unknown'
  const stdDev = baselineStdDev > 0 ? baselineStdDev : 0.5
  const deviations = (baselineMean - lastDownload) / stdDev
  if (deviations <= 1) return 'green'
  if (deviations <= 2) return 'yellow'
  return 'red'
}

// Full class names (no string interpolation) — required for Tailwind v4 static analysis
export const HEALTH_COLORS: Record<HealthStatus, string> = {
  green:   'bg-green-500',
  yellow:  'bg-yellow-400',
  red:     'bg-red-500',
  unknown: 'bg-gray-300',
}

export const HEALTH_TEXT_COLORS: Record<HealthStatus, string> = {
  green:   'text-green-700',
  yellow:  'text-yellow-700',
  red:     'text-red-700',
  unknown: 'text-gray-500',
}

export const HEALTH_LABELS: Record<HealthStatus, string> = {
  green:   'Healthy',
  yellow:  'Degraded',
  red:     'Critical',
  unknown: 'No Data',
}
