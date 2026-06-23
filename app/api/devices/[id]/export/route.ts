
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

function escapeCSV(val: string | null | undefined): string {
  if (val == null) return ''
  const s = String(val)
  // Prevent formula injection — prefix dangerous leading chars with a single quote
  const sanitized = s.replace(/^[=+\-@\t\r]/, "'$&")
  if (sanitized.includes(',') || sanitized.includes('"') || sanitized.includes('\n')) {
    return `"${sanitized.replace(/"/g, '""')}"`
  }
  return sanitized
}

const CSV_HEADERS = [
  'timestamp_utc',
  'hostname',
  'download_mbps',
  'upload_mbps',
  'latency_ms',
  'jitter_ms',
  'ssid',
  'band',
  'channel',
  'rssi_dbm',
  'mcs_index',
  'vpn_status',
  'vpn_name',
  'status',
]

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Await params — Next.js 16 requirement
  const { id: deviceId } = await params

  // Auth + admin role check
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', user.id)
    .single()
  if (profile?.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Parse days param (default 30, max 90)
  const rawDays = parseInt(request.nextUrl.searchParams.get('days') ?? '30', 10)
  const days = Math.min(rawDays > 0 ? rawDays : 30, 90)

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabaseAdmin
    .from('speed_results')
    .select(
      'timestamp_utc, hostname, download_mbps, upload_mbps, latency_ms, jitter_ms, ssid, band, channel, rssi_dbm, mcs_index, vpn_status, vpn_name, status',
    )
    .eq('device_id', deviceId)
    .gte('timestamp_utc', since)
    .order('timestamp_utc', { ascending: false })

  if (error) {
    return NextResponse.json({ error: 'Failed to fetch device data' }, { status: 500 })
  }

  const rows = data ?? []

  // Build CSV — header row + data rows
  const lines: string[] = [CSV_HEADERS.join(',')]

  for (const row of rows) {
    const line = [
      escapeCSV(row.timestamp_utc as string),
      escapeCSV(row.hostname as string),
      row.download_mbps != null ? String(row.download_mbps) : '',
      row.upload_mbps != null ? String(row.upload_mbps) : '',
      row.latency_ms != null ? String(row.latency_ms) : '',
      row.jitter_ms != null ? String(row.jitter_ms) : '',
      escapeCSV(row.ssid as string),
      escapeCSV(row.band as string),
      row.channel != null ? String(row.channel) : '',
      row.rssi_dbm != null ? String(row.rssi_dbm) : '',
      row.mcs_index != null ? String(row.mcs_index) : '',
      escapeCSV(row.vpn_status as string),
      escapeCSV(row.vpn_name as string),
      escapeCSV(row.status as string),
    ].join(',')
    lines.push(line)
  }

  const csvString = lines.join('\r\n')

  // Return raw Response (not NextResponse.json) for file download
  return new Response(csvString, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="device-${deviceId}-${days}d.csv"`,
    },
  })
}
