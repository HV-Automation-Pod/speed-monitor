// POST /functions/v1/commands-ack
//
// Marks a remote command as completed (or failed). Called by the device after
// it executes a command returned by commands-poll.
//
// Body:
//   { "command_id": <bigint>, "status": "completed" | "failed", "result"?: "..." }
//
// Security: the row's device_id is matched against the authenticated deviceId,
// so a compromised key for device A cannot ack commands for device B.
//
// Returns:
//   200 { ok: true } on success
//   400/401/404/422 with { error: '...' }

import { z } from 'https://esm.sh/zod@4.3.6'
import { supabaseAdmin } from '../_shared/admin.ts'
import { validateApiKey } from '../_shared/api-auth.ts'

const AckPayload = z.object({
  command_id: z.number().int().positive(),
  status: z.enum(['completed', 'failed']),
  result: z.string().max(4096).optional(),
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const auth = await validateApiKey(request)
  if (!auth) return json({ error: 'Unauthorized' }, 401)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 422)
  }

  const parsed = AckPayload.safeParse(body)
  if (!parsed.success) {
    return json({ error: 'Validation failed', issues: parsed.error.issues }, 422)
  }

  // Match on both id AND device_id so a key for device A cannot ack device B's
  // commands. .select() after update tells us whether the row actually matched.
  const { data, error } = await supabaseAdmin
    .from('remote_commands')
    .update({
      status: parsed.data.status,
      result: parsed.data.result ?? null,
      executed_at: new Date().toISOString(),
    })
    .eq('id', parsed.data.command_id)
    .eq('device_id', auth.deviceId)
    .select('id')

  if (error) {
    console.error('[commands-ack] update error:', error)
    return json({ error: 'Internal error' }, 500)
  }

  if (!data || data.length === 0) {
    return json({ error: 'Command not found for this device' }, 404)
  }

  return json({ ok: true })
})
