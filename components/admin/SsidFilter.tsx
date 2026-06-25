'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { ALL_SSIDS, SSID_COOKIE } from '@/lib/admin/ssid'

interface SsidOption {
  ssid: string
  count: number
}

interface SsidFilterProps {
  current: string
  options: SsidOption[]
  /** When true (default), the choice persists across pages via cookie. Per-device
   *  pages pass false so a single device's network choice doesn't change the
   *  fleet-wide default. */
  persist?: boolean
}

export default function SsidFilter({ current, options, persist = true }: SsidFilterProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  function onChange(value: string) {
    if (persist) {
      // Persist as a cookie so the scope sticks across page navigation (1 year).
      document.cookie = `${SSID_COOKIE}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`
    }
    const params = new URLSearchParams(searchParams.toString())
    params.set('ssid', value)
    router.push(`${pathname}?${params.toString()}`)
    router.refresh()
  }

  return (
    <label className="flex items-center gap-2 text-sm">
      <svg className="w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
      </svg>
      <select
        value={current}
        onChange={(e) => onChange(e.target.value)}
        className="border border-gray-200 rounded-md px-2 py-1.5 text-sm bg-white text-gray-700 hover:border-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-200"
      >
        <option value={ALL_SSIDS}>All networks</option>
        {options.map((o) => (
          <option key={o.ssid} value={o.ssid}>
            {o.ssid} ({o.count})
          </option>
        ))}
      </select>
    </label>
  )
}
