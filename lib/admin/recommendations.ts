export interface SpeedResult {
  download_mbps: number | null
  upload_mbps: number | null
  latency_ms: number | null
  jitter_ms: number | null
  rssi_dbm: number | null
  vpn_status: string | null
}

/**
 * Rule-based recommendation engine for device diagnostics.
 * Returns up to 5 actionable strings, or a healthy fallback message.
 */
export function generateRecommendations(
  lastTests: SpeedResult[],
  baselineMean: number | null,
): string[] {
  if (lastTests.length === 0) {
    return ['No recent test data available — run a speed test to get recommendations']
  }

  const latest = lastTests[0]
  const recommendations: string[] = []

  // Rule 1: Weak signal
  if (latest.rssi_dbm != null && latest.rssi_dbm < -70) {
    recommendations.push(
      'Weak signal detected (RSSI ' + latest.rssi_dbm + ' dBm) — move closer to the access point or check for obstructions'
    )
  }

  // Rule 2: High jitter variability across last tests
  const jitterValues = lastTests
    .map((t) => t.jitter_ms)
    .filter((v): v is number => v != null)

  if (jitterValues.length >= 2) {
    const mean = jitterValues.reduce((a, b) => a + b, 0) / jitterValues.length
    const variance =
      jitterValues.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / jitterValues.length
    const stdDev = Math.sqrt(variance)
    if (stdDev > 10) {
      recommendations.push(
        'High jitter variability detected — check for wireless interference or network congestion'
      )
    }
  }

  // Rule 3: VPN active with low speeds
  if (
    latest.vpn_status === 'connected' &&
    latest.download_mbps != null &&
    latest.download_mbps < 10
  ) {
    recommendations.push(
      'VPN is active and speeds are low — VPN overhead may be limiting throughput; contact IT if this persists'
    )
  }

  // Rule 4: Significantly below baseline
  if (
    baselineMean != null &&
    latest.download_mbps != null &&
    latest.download_mbps < baselineMean * 0.5
  ) {
    recommendations.push(
      "Download speed is significantly below this device's normal baseline — consider restarting the network adapter"
    )
  }

  // Rule 5: High latency
  if (latest.latency_ms != null && latest.latency_ms > 100) {
    recommendations.push(
      'High latency detected — check for network congestion or contact your ISP'
    )
  }

  if (recommendations.length === 0) {
    return ['Connection looks healthy — no issues detected']
  }

  return recommendations.slice(0, 5)
}
