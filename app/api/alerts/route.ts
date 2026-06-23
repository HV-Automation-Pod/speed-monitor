
import { NextRequest, NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase/admin'

const VALID_METRICS = ['download_mbps', 'upload_mbps', 'latency_ms'] as const
const VALID_SCOPES = ['all', 'device'] as const

type Metric = (typeof VALID_METRICS)[number]
type Scope = (typeof VALID_SCOPES)[number]

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

// GET /api/alerts — list all alert_configs
export async function GET() {
  const user = await getAdminUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabaseAdmin
    .from('alert_configs')
    .select('*')
    .order('created_at', { ascending: false })

  if (error) {
    return NextResponse.json(
      { error: 'Failed to fetch alert configs' },
      { status: 500 }
    )
  }

  return NextResponse.json({ data: data ?? [] })
}

// POST /api/alerts — create a new alert rule
export async function POST(request: NextRequest) {
  const user = await getAdminUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: {
    name?: unknown
    metric?: unknown
    threshold?: unknown
    scope?: unknown
    device_id?: unknown
  }

  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { name, metric, threshold, scope, device_id } = body

  // Validate name
  if (typeof name !== 'string' || name.trim() === '') {
    return NextResponse.json(
      { error: 'name is required' },
      { status: 400 }
    )
  }

  // Validate metric
  if (!VALID_METRICS.includes(metric as Metric)) {
    return NextResponse.json(
      { error: `metric must be one of: ${VALID_METRICS.join(', ')}` },
      { status: 400 }
    )
  }

  // Validate threshold
  const thresholdNum = Number(threshold)
  if (!isFinite(thresholdNum) || thresholdNum <= 0) {
    return NextResponse.json(
      { error: 'threshold must be a positive number' },
      { status: 400 }
    )
  }

  // Validate scope
  if (!VALID_SCOPES.includes(scope as Scope)) {
    return NextResponse.json(
      { error: `scope must be one of: ${VALID_SCOPES.join(', ')}` },
      { status: 400 }
    )
  }

  // If scope === 'device', device_id must be provided
  if (scope === 'device' && (typeof device_id !== 'string' || device_id.trim() === '')) {
    return NextResponse.json(
      { error: 'device_id is required when scope is "device"' },
      { status: 400 }
    )
  }

  const { data, error } = await supabaseAdmin
    .from('alert_configs')
    .insert({
      name: (name as string).trim(),
      metric: metric as Metric,
      threshold_value: thresholdNum,
      scope: scope as Scope,
      scope_device_id: scope === 'device' ? (device_id as string).trim() : null,
      webhook_url: null, // No Slack delivery in Phase 3
      alert_type: 'threshold',
      enabled: true,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json(
      { error: 'Failed to create alert rule' },
      { status: 500 }
    )
  }

  return NextResponse.json({ data }, { status: 201 })
}

// DELETE /api/alerts — delete an alert rule by id
export async function DELETE(request: NextRequest) {
  const user = await getAdminUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { id?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const id = body.id
  if (!id || (typeof id !== 'number' && typeof id !== 'string')) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  const { error } = await supabaseAdmin
    .from('alert_configs')
    .delete()
    .eq('id', id)

  if (error) {
    return NextResponse.json(
      { error: 'Failed to delete alert rule' },
      { status: 500 }
    )
  }

  return NextResponse.json({ success: true }, { status: 200 })
}
