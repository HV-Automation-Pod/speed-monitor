import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Install Speed Monitor — HyperVerge IT',
  description: 'Install Speed Monitor on your Mac to let IT track your network performance.',
}

const VERCEL_URL = 'https://speed-monitor.vercel.app'
const INSTALL_CMD = `curl -fsSL ${VERCEL_URL}/install.sh | bash`

export default function SetupPage() {
  return (
    <div className="min-h-screen bg-gray-50 py-12 px-4">
      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="mb-10">
          <h1 className="text-3xl font-bold text-gray-900">
            Install Speed Monitor
          </h1>
          <p className="mt-2 text-gray-600">
            Monitors your internet performance every 10 minutes and reports to IT.
            Installation takes under 1 minute.
          </p>
        </div>

        {/* Path A: Managed Mac (Jamf) */}
        <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-xs font-semibold uppercase tracking-wide text-blue-600 bg-blue-50 px-2 py-1 rounded">
              Jamf (managed fleet)
            </span>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            IT Admin — Deploy via Jamf policy
          </h2>
          <ol className="list-decimal list-inside space-y-2 text-gray-700 text-sm">
            <li>
              Download the installer package:{' '}
              <a
                href={`${VERCEL_URL}/api/download`}
                className="text-blue-600 underline font-mono"
              >
                SpeedMonitor-4.0.0.pkg
              </a>
            </li>
            <li>In Jamf Pro, go to <strong>Computers › Packages</strong> and upload the .pkg</li>
            <li>Create a new Policy, add the package, scope to pilot group first (5–10 machines)</li>
            <li>
              After pilot machines appear in the{' '}
              <a href="/admin" className="text-blue-600 underline">
                admin dashboard
              </a>
              , expand scope to all devices
            </li>
          </ol>
        </div>

        {/* Path B: Manual (unmanaged / contractor) */}
        <div className="bg-white rounded-lg border border-gray-200 p-6 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-xs font-semibold uppercase tracking-wide text-gray-600 bg-gray-100 px-2 py-1 rounded">
              Manual install
            </span>
          </div>
          <h2 className="text-lg font-semibold text-gray-900 mb-2">
            Contractor or unmanaged Mac
          </h2>
          <p className="text-sm text-gray-600 mb-3">
            Open <strong>Terminal</strong> and run this command:
          </p>
          <div className="bg-gray-900 rounded-md px-4 py-3 mb-3 overflow-x-auto">
            <code className="text-green-400 text-sm font-mono whitespace-nowrap">
              {INSTALL_CMD}
            </code>
          </div>
          <p className="text-xs text-gray-500">
            The script downloads Speed Monitor, provisions your device, and starts the background service automatically.
          </p>
        </div>

        {/* Verification checklist */}
        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Verify installation
          </h2>
          <ul className="space-y-3 text-sm text-gray-700">
            <li className="flex items-start gap-3">
              <span className="text-green-500 font-bold mt-0.5">1.</span>
              <span>
                <strong>Menu bar icon</strong> — Look for the SpeedMonitor icon in your menu bar (top-right of screen). It shows your current download speed and WiFi network.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-green-500 font-bold mt-0.5">2.</span>
              <span>
                <strong>First speed test</strong> — The first test runs within 30 seconds of install. The icon will show a speed reading once complete.
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="text-green-500 font-bold mt-0.5">3.</span>
              <span>
                <strong>Admin dashboard</strong> — Your device should appear in the{' '}
                <a href="/admin" className="text-blue-600 underline">
                  IT admin dashboard
                </a>{' '}
                within 5 minutes.
              </span>
            </li>
          </ul>
        </div>

      </div>
    </div>
  )
}
