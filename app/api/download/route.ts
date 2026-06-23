
import { NextResponse } from 'next/server'

// Redirect to the v4.0.0 pkg served as a static asset from public/.
// Using a redirect (not serving binary inline) avoids Vercel's 4.5 MB
// serverless function response body limit.
// To release a new version: update PKG_PATH and place the new pkg in public/.
const PKG_PATH = '/SpeedMonitor-4.0.0.pkg'

export async function GET() {
  const base =
    process.env.NEXT_PUBLIC_SITE_URL ?? 'https://speed-monitor.riyan-b.workers.dev'
  return NextResponse.redirect(new URL(PKG_PATH, base))
}
