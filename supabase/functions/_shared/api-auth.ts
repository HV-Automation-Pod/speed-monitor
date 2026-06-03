// Validates the X-Api-Key header against device_api_keys.
// 1:1 port of lib/supabase/api-auth.ts — must remain wire-compatible with the
// existing macOS client (speed_monitor.sh), which sends:
//
//   X-Api-Key: <device_id>:<plaintext_api_key>
//
// Returns { deviceId, batchingEnabled } on success, null on any failure.
// batchingEnabled is read from the same row and used by callers to decide
// whether the new batched-ingest path is active for this device.

import bcrypt from 'https://esm.sh/bcryptjs@3.0.3'
import { supabaseAdmin } from './admin.ts'

export interface ApiKeyPayload {
  deviceId: string
  batchingEnabled: boolean
}

export async function validateApiKey(request: Request): Promise<ApiKeyPayload | null> {
  const apiKey = request.headers.get('X-Api-Key')
  if (!apiKey) return null

  const colonIdx = apiKey.indexOf(':')
  if (colonIdx === -1) return null

  const deviceId = apiKey.substring(0, colonIdx)
  const plainKey = apiKey.substring(colonIdx + 1)
  if (!deviceId || !plainKey) return null

  // Lookup by device_id avoids a full table scan. limit(5) handles the brief
  // window during key rotation where multiple active rows may coexist.
  const { data, error } = await supabaseAdmin
    .from('device_api_keys')
    .select('id, key_hash, batching_enabled')
    .eq('device_id', deviceId)
    .eq('revoked', false)
    .limit(5)

  if (error || !data || data.length === 0) return null

  for (const row of data) {
    const valid = await bcrypt.compare(plainKey, row.key_hash)
    if (valid) {
      // Best-effort last_used_at bump. Awaited so the row is updated before
      // the Edge runtime tears down the request context — fire-and-forget
      // without waitUntil() risks the update being dropped.
      void supabaseAdmin
        .from('device_api_keys')
        .update({ last_used_at: new Date().toISOString() })
        .eq('id', row.id)

      return { deviceId, batchingEnabled: Boolean(row.batching_enabled) }
    }
  }

  return null
}
