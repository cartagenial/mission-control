import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { requireRole } from '@/lib/auth'
import { logger } from '@/lib/logger'
import { loginFromEnv, makeDifyHeaders } from '@/lib/dify-client'

const DIFY_API_URL = process.env.DIFY_API_URL || 'http://nginx:80'
const DIFY_ORCHESTRATOR_KEY = process.env.DIFY_ORCHESTRATOR_API_KEY || ''
const DAILY_BUDGET_USD = parseFloat(process.env.DIFY_DAILY_BUDGET_USD || '5.00')

interface DifyApp {
  id: string
  name: string
  mode: string
  description: string
  icon: string
  icon_background: string
  created_at: number
}

interface DifyWorkflowRun {
  id: string
  status: string
  total_tokens: number
  elapsed_time: number
  outputs: Record<string, unknown>
  created_at: number
}

/**
 * GET /api/dify — Get Dify integration status and synced agents
 */
export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const db = getDatabase()
    const agents = db.prepare(
      "SELECT * FROM agents WHERE config LIKE '%\"framework\":\"dify\"%' ORDER BY name"
    ).all()

    return NextResponse.json({
      status: 'ok',
      dify_url: DIFY_API_URL,
      orchestrator_configured: !!DIFY_ORCHESTRATOR_KEY,
      agents,
    })
  } catch (err) {
    logger.error({ err }, 'Failed to get Dify status')
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

/**
 * POST /api/dify — Sync Dify apps as MC agents or run orchestrator
 * Body: { action: "sync" | "run", query?: string }
 */
export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })

  try {
    const body = await request.json()
    const action = body.action as string

    if (action === 'sync') {
      return await syncDifyApps(auth.user.workspace_id ?? 1)
    }

    if (action === 'run') {
      return await runOrchestrator(body.query as string, auth.user.username || 'mc-operator')
    }

    return NextResponse.json({ error: 'Unknown action. Use "sync" or "run".' }, { status: 400 })
  } catch (err) {
    logger.error({ err }, 'Dify API error')
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}

/**
 * Sync Dify workflow apps as agents in Mission Control.
 * Fetches apps from Dify console API and upserts them in the agents table.
 */
async function syncDifyApps(workspaceId: number) {
  // Login to Dify console to get apps list
  const tokens = await loginFromEnv()
  if (!tokens) {
    return NextResponse.json({
      error: 'Cannot authenticate with Dify console. Check DIFY_ADMIN_EMAIL and DIFY_ADMIN_PASSWORD env vars.',
    }, { status: 502 })
  }

  const appsRes = await fetch(`${DIFY_API_URL}/console/api/apps`, {
    headers: makeDifyHeaders(tokens),
  })

  if (!appsRes.ok) {
    return NextResponse.json({ error: `Dify apps fetch failed: ${appsRes.status}` }, { status: 502 })
  }

  const appsData = await appsRes.json() as { data: DifyApp[] }
  const apps = appsData.data || []

  const db = getDatabase()
  const upsert = db.prepare(`
    INSERT INTO agents (name, role, status, session_key, config)
    VALUES (?, ?, 'online', ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      status = 'online',
      config = excluded.config,
      updated_at = unixepoch()
  `)

  let synced = 0
  const syncedAgents: string[] = []

  for (const app of apps) {
    const role = inferRole(app.name, app.description)
    const config = JSON.stringify({
      framework: 'dify',
      dify_app_id: app.id,
      dify_mode: app.mode,
      description: app.description,
      icon: app.icon,
    })

    upsert.run(app.name, role, `dify:${app.id}`, config)
    synced++
    syncedAgents.push(app.name)

    eventBus.broadcast('agent.created', {
      id: `dify:${app.id}`,
      name: app.name,
      framework: 'dify',
      status: 'online',
    })
  }

  logger.info({ synced, apps: syncedAgents }, 'Dify apps synced as MC agents')

  return NextResponse.json({
    status: 'ok',
    synced,
    agents: syncedAgents,
  })
}

/**
 * Run a query through the Dify Orchestrator workflow and track it in MC.
 */
async function runOrchestrator(query: string, user: string) {
  if (!DIFY_ORCHESTRATOR_KEY) {
    return NextResponse.json({
      error: 'DIFY_ORCHESTRATOR_API_KEY not configured',
    }, { status: 400 })
  }

  if (!query?.trim()) {
    return NextResponse.json({ error: 'query is required' }, { status: 400 })
  }

  // Check daily spending limit
  const budgetCheck = await checkDailyBudget()
  if (!budgetCheck.ok) {
    logger.warn({ spent: budgetCheck.spent, limit: DAILY_BUDGET_USD }, 'Daily budget exceeded — blocking workflow run')
    return NextResponse.json({
      error: `Daily budget exceeded: $${budgetCheck.spent.toFixed(4)} / $${DAILY_BUDGET_USD.toFixed(2)}. Adjust DIFY_DAILY_BUDGET_USD to increase.`,
      spent: budgetCheck.spent,
      limit: DAILY_BUDGET_USD,
    }, { status: 429 })
  }

  // Call Dify orchestrator workflow
  const runRes = await fetch(`${DIFY_API_URL}/v1/workflows/run`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${DIFY_ORCHESTRATOR_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      inputs: { query },
      response_mode: 'blocking',
      user,
    }),
  })

  if (!runRes.ok) {
    const errText = await runRes.text()
    return NextResponse.json({ error: `Dify workflow failed: ${errText}` }, { status: 502 })
  }

  const result = await runRes.json() as { data: DifyWorkflowRun }
  const run = result.data

  // Log token usage in MC via internal tokens API (JSON file storage)
  if (run.total_tokens) {
    try {
      const { readFile, writeFile } = await import('fs/promises')
      const { config: appCfg } = await import('@/lib/config')
      const tokensPath = appCfg.tokensPath

      const estimatedInput = Math.round(run.total_tokens * 0.6)
      const estimatedOutput = run.total_tokens - estimatedInput
      const cost = (estimatedInput / 1_000_000) * 3 + (estimatedOutput / 1_000_000) * 15

      const record = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        model: 'claude-sonnet-4-20250514',
        sessionId: 'dify:orchestrator',
        agentName: 'Orchestrator',
        timestamp: Date.now(),
        inputTokens: estimatedInput,
        outputTokens: estimatedOutput,
        totalTokens: run.total_tokens,
        cost,
        operation: 'workflow_run',
        workspaceId: 1,
        duration: run.elapsed_time ? Math.round(run.elapsed_time * 1000) : undefined,
      }

      let existing: unknown[] = []
      try {
        const raw = await readFile(tokensPath, 'utf-8')
        existing = JSON.parse(raw)
      } catch { /* file may not exist yet */ }

      existing.unshift(record)
      if (existing.length > 10000) existing.splice(10000)
      await writeFile(tokensPath, JSON.stringify(existing, null, 2))
    } catch (tokenErr) {
      logger.warn({ err: tokenErr }, 'Failed to log Dify token usage')
    }
  }

  // Log activity
  eventBus.broadcast('activity.created', {
    type: 'workflow_run',
    entity: 'dify:orchestrator',
    actor: user,
    description: `Orchestrator routed to ${(run.outputs as Record<string, string>)?.team || 'agent'}: "${query.slice(0, 80)}"`,
  })

  return NextResponse.json({
    status: run.status,
    team: (run.outputs as Record<string, string>)?.team,
    result: (run.outputs as Record<string, string>)?.result,
    tokens: run.total_tokens,
    elapsed: run.elapsed_time,
  })
}


/**
 * Infer agent role from app name/description.
 */
function inferRole(name: string, description: string): string {
  const combined = `${name} ${description}`.toLowerCase()
  if (combined.includes('orchestrat')) return 'orchestrator'
  if (combined.includes('research') || combined.includes('recherche')) return 'researcher'
  if (combined.includes('develop') || combined.includes('dev')) return 'developer'
  if (combined.includes('operation') || combined.includes('ops')) return 'operator'
  return 'assistant'
}

/**
 * Check if daily spending is within budget.
 * Reads token usage from the MC JSON file and sums today's costs.
 */
async function checkDailyBudget(): Promise<{ ok: boolean; spent: number }> {
  try {
    const { readFile } = await import('fs/promises')
    const { config: appCfg } = await import('@/lib/config')

    const raw = await readFile(appCfg.tokensPath, 'utf-8')
    const records = JSON.parse(raw) as Array<{ timestamp: number; cost: number; sessionId?: string }>

    const now = new Date()
    const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const todayMs = todayStart

    const todaySpent = records
      .filter(r => r.timestamp >= todayMs && r.sessionId?.startsWith('dify:'))
      .reduce((sum, r) => sum + (r.cost || 0), 0)

    return { ok: todaySpent < DAILY_BUDGET_USD, spent: todaySpent }
  } catch {
    // No token file yet = no spending = OK
    return { ok: true, spent: 0 }
  }
}
