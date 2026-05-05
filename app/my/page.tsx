import { redirect } from 'next/navigation'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import DevicePicker from '@/components/my/DevicePicker'

export const dynamic = 'force-dynamic'

export default async function MyPage() {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/')

  // Look up devices that have posted results tagged with this email
  const { data: mappings } = await supabaseAdmin
    .from('speed_results')
    .select('device_id')
    .eq('user_email', user.email)
    .order('timestamp_utc', { ascending: false })
    .limit(500)

  const deviceIds = [...new Set((mappings ?? []).map((m: { device_id: string }) => m.device_id))]

  // Empty state: no devices registered to this email
  if (deviceIds.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen p-8 text-center">
        <div className="max-w-md">
          <div className="text-6xl mb-6">📡</div>
          <h1 className="text-2xl font-semibold text-gray-900 mb-3">No device data yet</h1>
          <p className="text-gray-600 mb-6">
            Make sure the Speed Monitor app is running on your Mac. It may take a few minutes
            for your first results to appear.
          </p>
          <a
            href="/setup"
            className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            View setup instructions
          </a>
        </div>
      </div>
    )
  }

  // Single device: redirect directly to its dashboard
  if (deviceIds.length === 1) {
    redirect(`/my/${deviceIds[0]}`)
  }

  // Multiple devices: fetch hostnames and show picker
  const { data: deviceRows } = await supabaseAdmin
    .from('speed_results')
    .select('device_id, hostname')
    .in('device_id', deviceIds)
    .order('timestamp_utc', { ascending: false })
    .limit(deviceIds.length * 5)  // Fetch enough rows to get hostname for each

  // Deduplicate: one entry per device_id, preferring rows with a hostname
  const deviceMap = new Map<string, string | null>()
  for (const row of deviceRows ?? []) {
    if (!deviceMap.has(row.device_id) || (row.hostname && !deviceMap.get(row.device_id))) {
      deviceMap.set(row.device_id, row.hostname ?? null)
    }
  }

  const devices = deviceIds.map((id: string) => ({
    deviceId: id,
    hostname: deviceMap.get(id) ?? null,
  }))

  return (
    <div className="flex flex-col items-center justify-center min-h-screen p-8">
      <div className="max-w-lg w-full">
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">Your devices</h1>
        <p className="text-gray-600 mb-6">Select a device to view its connection health.</p>
        <DevicePicker devices={devices} />
      </div>
    </div>
  )
}
