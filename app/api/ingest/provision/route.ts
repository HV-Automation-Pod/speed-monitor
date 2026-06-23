export const runtime = 'edge'

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase/admin'
import bcrypt from 'bcryptjs'

// bcrypt cost factor: 12 rounds ≈ 2-3 hashes/sec on modern serverless; acceptable for provisioning
// (not per-request auth — only called once during device install)
const SALT_ROUNDS = 12

export async function POST(request: Request) {
  let body: { device_id?: string } = {}
  try {
    body = await request.json()
  } catch {
    // Body is optional — new device provision has no body
  }

  // Generate cryptographically secure 32-byte API key (64 hex chars, 256 bits entropy)
  const apiKey = Array.from(crypto.getRandomValues(new Uint8Array(32))).map(b => b.toString(16).padStart(2, '0')).join('')
  const keyHash = await bcrypt.hash(apiKey, SALT_ROUNDS)

  if (body.device_id) {
    // Re-provision: revoke all active keys for this device, issue a new one
    // Use case: re-install, key rotation, compromised key
    const { error: revokeError } = await supabaseAdmin
      .from('device_api_keys')
      .update({ revoked: true })
      .eq('device_id', body.device_id)
      .eq('revoked', false)

    if (revokeError) {
      console.error('Failed to revoke existing keys:', revokeError)
      return NextResponse.json({ error: 'Failed to revoke existing keys' }, { status: 500 })
    }

    const { error: insertError } = await supabaseAdmin
      .from('device_api_keys')
      .insert({
        device_id: body.device_id,
        key_hash: keyHash,
        revoked: false,
      })

    if (insertError) {
      console.error('Failed to insert new key:', insertError)
      return NextResponse.json({ error: 'Failed to provision key' }, { status: 500 })
    }

    // Return both device_id and new api_key — api_key is plaintext ONLY this once
    return NextResponse.json({ device_id: body.device_id, api_key: apiKey })
  }

  // New device: server-assigned device_id (UUID v4)
  const deviceId = crypto.randomUUID()

  const { error: insertError } = await supabaseAdmin
    .from('device_api_keys')
    .insert({
      device_id: deviceId,
      key_hash: keyHash,
      revoked: false,
    })

  if (insertError) {
    console.error('Failed to create device key:', insertError)
    return NextResponse.json({ error: 'Failed to provision device' }, { status: 500 })
  }

  // Return device_id and api_key — client stores both to ~/.config/nkspeedtest/
  return NextResponse.json({ device_id: deviceId, api_key: apiKey }, { status: 201 })
}
