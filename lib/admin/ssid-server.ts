import { cookies } from 'next/headers'
import { supabaseAdmin } from '@/lib/supabase/admin'
import { DEFAULT_SSID, SSID_COOKIE } from '@/lib/admin/ssid'

/**
 * Resolves the active SSID scope for a dashboard page (server-only).
 * Precedence: explicit ?ssid= param → persisted cookie → DEFAULT_SSID.
 * Returns ALL_SSIDS when the user has chosen "All networks".
 */
export async function resolveSsid(searchParamSsid?: string): Promise<string> {
  if (searchParamSsid && searchParamSsid.length > 0) return searchParamSsid
  const store = await cookies()
  return store.get(SSID_COOKIE)?.value ?? DEFAULT_SSID
}

/** Networks seen in the last `days`, with row counts, for the filter dropdown. */
export async function getAvailableSsids(days = 14): Promise<{ ssid: string; count: number }[]> {
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const { data } = await supabaseAdmin
    .from('speed_results')
    .select('ssid')
    .gte('timestamp_utc', since)
    .not('ssid', 'is', null)
    .limit(20000)

  const counts = new Map<string, number>()
  for (const r of data ?? []) {
    const s = (r.ssid as string | null) ?? ''
    if (s) counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([ssid, count]) => ({ ssid, count }))
    .sort((a, b) => b.count - a.count)
}
