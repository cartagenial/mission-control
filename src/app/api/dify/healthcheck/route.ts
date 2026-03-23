import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { logger } from '@/lib/logger'
import { loginFromEnv } from '@/lib/dify-client'

const DIFY_API_URL = process.env.DIFY_API_URL || 'http://nginx:80'

/**
 * GET /api/dify/healthcheck — Poll Dify service health and update agent status.
 * Designed to be called by MC's internal cron scheduler or externally via curl.
 *
 * Checks:
 * 1. Dify API is responding
 * 2. Updates all Dify-framework agents to online/offline accordingly
 * 3. Returns health summary
 */
export async function GET(request: NextRequest) {
  const results: Record<string, string> = {}

  // Check Dify API health
  let difyHealthy = false
  try {
    const res = await fetch(`${DIFY_API_URL}/console/api/setup`, {
      signal: AbortSignal.timeout(5000),
    })
    difyHealthy = res.ok
    results.dify_api = difyHealthy ? 'healthy' : `unhealthy (${res.status})`
  } catch (err) {
    results.dify_api = 'unreachable'
  }

  // Update Dify agent statuses in MC
  try {
    const db = getDatabase()
    const difyAgents = db.prepare(
      "SELECT id, name, status, session_key FROM agents WHERE config LIKE '%\"framework\":\"dify\"%'"
    ).all() as Array<{ id: number; name: string; status: string; session_key: string }>

    const newStatus = difyHealthy ? 'online' : 'offline'

    for (const agent of difyAgents) {
      if (agent.status !== newStatus) {
        db.prepare('UPDATE agents SET status = ?, updated_at = unixepoch() WHERE id = ?')
          .run(newStatus, agent.id)

        eventBus.broadcast('agent.status_changed', {
          id: agent.session_key,
          name: agent.name,
          status: newStatus,
          framework: 'dify',
        })
      }
    }

    results.agents_updated = `${difyAgents.length} agents → ${newStatus}`
  } catch (err) {
    logger.error({ err }, 'Failed to update Dify agent statuses')
    results.agents_updated = 'error'
  }

  // Login contract check — verify console API auth handshake
  if (difyHealthy && process.env.DIFY_ADMIN_EMAIL && process.env.DIFY_ADMIN_PASSWORD) {
    const tokens = await loginFromEnv()
    results.login_contract = tokens ? 'healthy' : 'failed'
  } else if (!process.env.DIFY_ADMIN_EMAIL || !process.env.DIFY_ADMIN_PASSWORD) {
    results.login_contract = 'skipped'
  }

  // Check individual workflow apps if we have API keys
  const orchestratorKey = process.env.DIFY_ORCHESTRATOR_API_KEY
  if (orchestratorKey && difyHealthy) {
    try {
      const res = await fetch(`${DIFY_API_URL}/v1/parameters`, {
        headers: { 'Authorization': `Bearer ${orchestratorKey}` },
        signal: AbortSignal.timeout(5000),
      })
      results.orchestrator = res.ok ? 'healthy' : `error (${res.status})`
    } catch {
      results.orchestrator = 'unreachable'
    }
  }

  const overallHealthy = difyHealthy
  return NextResponse.json({
    status: overallHealthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    checks: results,
  }, { status: overallHealthy ? 200 : 503 })
}
