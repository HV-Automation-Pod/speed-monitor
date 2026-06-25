// Client-safe constants + pure helpers (no server-only imports, so this module
// can be imported by both Server Components and the SsidFilter client component).

// The office network. Dashboard aggregates default to this so "fleet health"
// reflects a consistent environment, not a mix of home/café/hotspot Wi-Fi.
export const DEFAULT_SSID = 'HypervergeHQ'

// Sentinel for "don't filter — show every network".
export const ALL_SSIDS = '__all__'

export const SSID_COOKIE = 'dash_ssid'

/** True when the scope is a specific network (i.e. a filter should be applied). */
export function isScoped(ssid: string): boolean {
  return ssid !== ALL_SSIDS
}
