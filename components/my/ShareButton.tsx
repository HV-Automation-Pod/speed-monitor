'use client'

import { useState } from 'react'

export default function ShareButton({ deviceId }: { deviceId: string }) {
  const [copied, setCopied] = useState(false)

  async function handleShare() {
    try {
      const url = `${window.location.origin}/admin/devices/${deviceId}`
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      // Clipboard may fail on HTTP (local dev) — gracefully do nothing
      console.warn('[ShareButton] clipboard write failed:', err)
    }
  }

  return (
    <div className="relative inline-block">
      <button
        onClick={handleShare}
        className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 hover:border-gray-400 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
        </svg>
        Share with IT
      </button>
      {copied && (
        <span className="absolute top-full mt-2 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-xs px-3 py-1.5 rounded-lg whitespace-nowrap pointer-events-none z-10">
          Link copied
        </span>
      )}
    </div>
  )
}
