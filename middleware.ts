import { updateSession } from '@/lib/supabase/middleware'
import type { NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  return await updateSession(request)
}

// Run middleware on all routes except static assets, Next.js internals,
// public installation files served from public/, and the high-volume device
// APIs (/api/ingest/*, /api/commands/*) which authenticate via X-Api-Key
// in the handler and don't need a Supabase session check.
// NOTE: Middleware alone is NOT sufficient for auth (CVE-2025-29927: x-middleware-subrequest bypass).
// Every protected Route Handler MUST also call supabase.auth.getUser() internally.
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/ingest|api/commands|install\\.sh|speed_monitor\\.sh|SpeedMonitor\\.app\\.zip|SpeedMonitor-.*\\.pkg|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
