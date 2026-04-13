import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')

  if (!code) {
    return NextResponse.redirect(`${origin}/?error=auth_failed`)
  }

  const supabase = await createSupabaseServerClient()
  const { data: { session }, error } = await supabase.auth.exchangeCodeForSession(code)

  if (error || !session?.user) {
    return NextResponse.redirect(`${origin}/?error=auth_failed`)
  }

  const user = session.user
  const email = user.email ?? ''

  // Server-side domain check — defense-in-depth fallback to the before_user_created hook.
  // Hook is primary gate; this catches any hook misconfiguration or future provider additions.
  if (!email.toLowerCase().endsWith('@hyperverge.co')) {
    await supabase.auth.signOut()
    return NextResponse.redirect(`${origin}/?error=unauthorized`)
  }

  // Upsert profile row — idempotent on re-login (ignoreDuplicates: true means existing row is preserved)
  await supabase.from('profiles').upsert(
    {
      user_id: user.id,
      email,
      role: 'employee', // default role; IT promotes to admin directly in Supabase dashboard
    },
    { onConflict: 'user_id', ignoreDuplicates: true }
  )

  // Role-based redirect
  // If no profile row (race condition), default to employee → /my (do NOT block access)
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', user.id)
    .single()

  const role = profile?.role ?? 'employee'
  return NextResponse.redirect(`${origin}/${role === 'admin' ? 'admin' : 'my'}`)
}
