import { updateSession } from '@/lib/supabase/middleware'
import type { NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  return await updateSession(request)
}

// Run middleware on all routes except static assets, Next.js internals,
// and public installation files served from public/.
// NOTE: Middleware alone is NOT sufficient for auth (CVE-2025-29927: x-middleware-subrequest bypass).
// Every protected Route Handler MUST also call supabase.auth.getUser() internally.
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|install\\.sh|speed_monitor\\.sh|SpeedMonitor\\.app\\.zip|SpeedMonitor-.*\\.pkg|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
