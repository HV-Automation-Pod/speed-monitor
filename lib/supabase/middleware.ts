import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function updateSession(request: NextRequest) {
  const pathname = request.nextUrl.pathname

  // Public routes that don't need a Supabase session check:
  // - / (login page — anonymous by definition)
  // - /auth/* (OAuth callback owns its own session via createSupabaseServerClient)
  // - /setup (public installation guide for IT admins and contractors)
  // - /api/download (pkg download redirect — accessible to IT/Jamf without login)
  //
  // /api/ingest/* and /api/commands/* are excluded by the matcher in middleware.ts
  // and never reach here — they auth via X-Api-Key in the route handler.
  //
  // Short-circuiting here avoids one supabase.auth.getUser() network round-trip
  // (and JWT verify) per request, which was the dominant Vercel Active CPU cost.
  const isPublicRoute =
    pathname === '/' ||
    pathname.startsWith('/auth/') ||
    pathname === '/setup' ||
    pathname === '/api/download'

  if (isPublicRoute) {
    return NextResponse.next({ request })
  }

  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  // IMPORTANT: use getUser() — NOT getSession().
  // getSession() reads from cookie without revalidating the JWT against Supabase's auth server.
  // An attacker could craft a valid-looking expired cookie. getUser() makes a network call to validate.
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}
