// GET/POST /functions/v1/commands-poll
//
// Returns any pending remote commands for the authenticated device, plus a
// per-device config block the client uses to gate feature behavior (currently
// just batching_enabled — read straight from device_api_keys by validateApiKey).
//
// The authenticated device_id is the only one this function operates on —
// there is no device_id in URL or body. This avoids cross-device polling
// and keeps the contract minimal.
//
// Method: GET preferred (idempotent read). POST also accepted for clients
// that prefer a single verb across all endpoints.
//
// Returns:
//   200 { commands: [{id, command, created_at}, ...], config: { batching_enabled } }
//   401 on missing/invalid X-Api-Key

import { supabaseAdmin } from '../_shared/admin.ts'
import { validateApiKey } from '../_shared/api-auth.ts'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (request) => {
  if (request.method !== 'GET' && request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const auth = await validateApiKey(request)
  if (!auth) return json({ error: 'Unauthorized' }, 401)

  const { data, error } = await supabaseAdmin
    .from('remote_commands')
    .select('id, command, created_at')
    .eq('device_id', auth.deviceId)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })

  if (error) {
    console.error('[commands-poll] fetch error:', error)
    return json({ error: 'Internal error' }, 500)
  }

  return json({
    commands: data ?? [],
    config: {
      batching_enabled: auth.batchingEnabled,
    },
  })
})
