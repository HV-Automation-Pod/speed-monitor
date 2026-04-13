import { createClient } from '@supabase/supabase-js'

// supabaseAdmin bypasses RLS via service_role key.
// CRITICAL: Import this ONLY in server-side Route Handlers (app/api/**).
// NEVER import in Client Components, layouts, or pages — service_role key must not reach browser.
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      // persistSession: false prevents @supabase/ssr from injecting session cookies
      // into this client, which would silently override the service_role with the user JWT.
      // Without this, RLS bypass fails even with the correct service_role key.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  }
)
