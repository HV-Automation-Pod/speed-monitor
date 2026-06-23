export const runtime = 'edge'

import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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

  // Delete all device data across tables (order matters — FK refs first)
  const tables = [
    'alert_history',
    'remote_commands',
    'device_user_map',
    'daily_aggregates',
    'device_baselines',
    'speed_results',
    'device_api_keys',
  ] as const

  for (const table of tables) {
    const { error } = await supabaseAdmin
      .from(table)
      .delete()
      .eq('device_id', deviceId)
    if (error) {
      console.error(`Failed to delete from ${table}:`, error.message)
      // Continue — partial deletion is better than bailing early
    }
  }

  return NextResponse.json({ success: true })
}
