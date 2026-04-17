import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function updateSession(request: NextRequest) {
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

  const pathname = request.nextUrl.pathname

  // Protect all routes except:
  // - / (login page — must be public)
  // - /auth/* (OAuth callback route)
  // - /api/ingest/* (device API — authenticated via X-Api-Key, not session)
  // - /api/commands/* (device API — authenticated via X-Api-Key, not session)
  // - /setup (public installation guide for IT admins and contractors)
  // - /api/download (pkg download redirect — must be accessible to IT/Jamf without login)
  const isPublicRoute =
    pathname === '/' ||
    pathname.startsWith('/auth/') ||
    pathname.startsWith('/api/ingest/') ||
    pathname.startsWith('/api/commands/') ||
    pathname === '/setup' ||
    pathname === '/api/download'

  if (!user && !isPublicRoute) {
    const url = request.nextUrl.clone()
    url.pathname = '/'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}
