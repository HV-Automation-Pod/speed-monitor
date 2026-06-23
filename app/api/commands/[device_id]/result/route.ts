
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { validateApiKey } from '@/lib/supabase/api-auth'
import { supabaseAdmin } from '@/lib/supabase/admin'

const ResultPayload = z.object({
  status: z.enum(['completed', 'failed']),
  result: z.string().optional(),
})

export async function POST(
  request: Request,
  { params }: { params: Promise<{ device_id: string }> }
) {
  const auth = await validateApiKey(request)
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { device_id } = await params
  const commandId = parseInt(device_id, 10)
  if (isNaN(commandId)) {
    return NextResponse.json({ error: 'Invalid command id' }, { status: 400 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = ResultPayload.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', issues: parsed.error.issues },
      { status: 422 }
    )
  }

  // Verify this command belongs to the authenticated device (prevent cross-device tampering)
  const { data: cmd, error: fetchError } = await supabaseAdmin
    .from('remote_commands')
    .select('device_id')
    .eq('id', commandId)
    .single()

  if (fetchError || !cmd) {
    return NextResponse.json({ error: 'Command not found' }, { status: 404 })
  }

  if (cmd.device_id !== auth.deviceId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { error: updateError } = await supabaseAdmin
    .from('remote_commands')
    .update({
      status: parsed.data.status,
      result: parsed.data.result ?? null,
      executed_at: new Date().toISOString(),
    })
    .eq('id', commandId)

  if (updateError) {
    console.error('Failed to update command result:', updateError)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
