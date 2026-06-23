import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// supabaseAdmin bypasses RLS via service_role key.
// CRITICAL: Import this ONLY in server-side Route Handlers (app/api/**).
// NEVER import in Client Components, layouts, or pages — service_role key must not reach browser.
//
// Lazy-initialized via Proxy so the client isn't created at module load time
// (build-time module evaluation would throw if env vars aren't set yet).
let _client: SupabaseClient | null = null

function getClient(): SupabaseClient {
  if (!_client) {
    _client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      }
    )
  }
  return _client
}

export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_, prop: string) {
    return getClient()[prop as keyof SupabaseClient]
  },
})
