// Supabase client with service_role key — bypasses RLS.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected by the Edge
// Functions runtime, so no manual secret configuration is needed.
//
// Mirrors lib/supabase/admin.ts in the Next.js app: persistSession=false to
// prevent any cookie/JWT injection from silently overriding service_role.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.103.0'

export const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  },
)
