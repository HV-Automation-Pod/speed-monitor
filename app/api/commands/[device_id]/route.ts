
import { NextResponse } from 'next/server'
import { validateApiKey } from '@/lib/supabase/api-auth'
import { supabaseAdmin } from '@/lib/supabase/admin'

export async function GET(
  request: Request,
  { params }: { params: Promise<{ device_id: string }> }
) {
  const auth = await validateApiKey(request)
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { device_id } = await params

  // Prevent cross-device polling: authenticated device can only poll its own commands
  if (auth.deviceId !== device_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data, error } = await supabaseAdmin
    .from('remote_commands')
    .select('id, command, created_at')
    .eq('device_id', device_id)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })

  if (error) {
    console.error('Failed to fetch commands:', error)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  return NextResponse.json({ commands: data ?? [] })
}
