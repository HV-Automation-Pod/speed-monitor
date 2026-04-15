import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

async function getAdminUser() {
  const supabase = await createSupabaseServerClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('user_id', user.id)
    .single()
  if (profile?.role !== 'admin') return null
  return user
}

export async function POST(request: NextRequest) {
  const user = await getAdminUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { config_id?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const configId = body.config_id
  if (typeof configId !== 'number' && typeof configId !== 'string') {
    return NextResponse.json({ error: 'config_id is required' }, { status: 400 })
  }

  // Fetch config to get metric + threshold
  const { data: config, error: fetchError } = await supabaseAdmin
    .from('alert_configs')
    .select('id, metric, threshold_value, scope_device_id')
    .eq('id', configId)
    .single()

  if (fetchError || !config) {
    return NextResponse.json({ error: 'Alert config not found' }, { status: 404 })
  }

  // Use scope_device_id if available; otherwise use a placeholder device ID
  const deviceId = config.scope_device_id ?? '00000000-0000-0000-0000-000000000000'

  // Synthetic metric value: for latency, use 200% of threshold (triggers above-threshold rule)
  // For speed metrics, use 50% of threshold (triggers below-threshold rule)
  const thresholdVal = config.threshold_value ?? 0
  const metricValue =
    config.metric === 'latency_ms'
      ? Math.round(thresholdVal * 2 * 100) / 100
      : Math.round(thresholdVal * 0.5 * 100) / 100

  const { error: insertError } = await supabaseAdmin
    .from('alert_history')
    .insert({
      config_id: config.id,
      device_id: deviceId,
      metric_value: metricValue,
      message: `Test alert — synthetic event for rule "${config.metric}"`,
      delivered: false,
    })

  if (insertError) {
    return NextResponse.json({ error: 'Failed to insert test alert' }, { status: 500 })
  }

  return NextResponse.json({ success: true }, { status: 201 })
}
