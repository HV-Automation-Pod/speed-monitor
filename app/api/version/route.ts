
import { NextResponse } from 'next/server'

// Public endpoint — no auth required.
// macOS devices check this before provisioning; must be accessible without a session.
export async function GET() {
  return NextResponse.json({
    current_version: '3.1.0',
    min_client_version: '3.0.0',
    server: 'speed-monitor-v3',
  })
}
