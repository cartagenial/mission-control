/**
 * Shared Dify console API client.
 *
 * Centralizes the login handshake (base64 password, cookie extraction)
 * so that route.ts and scheduler.ts share one implementation.
 */

export interface DifyTokens {
  access: string
  csrf: string
}

export class DifyLoginError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message)
    this.name = 'DifyLoginError'
  }
}

/**
 * Login to Dify console API and extract session tokens from Set-Cookie headers.
 *
 * Contract (Dify 1.13.2):
 *   - POST /console/api/login with { email, password: base64(password) }
 *   - Response sets cookies: access_token=...; csrf_token=...
 *
 * Throws DifyLoginError on failure.
 */
export async function loginToDify(
  url: string,
  email: string,
  password: string,
  timeoutMs = 10_000,
): Promise<DifyTokens> {
  const b64Password = Buffer.from(password).toString('base64')

  const res = await fetch(`${url}/console/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: b64Password }),
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!res.ok) {
    throw new DifyLoginError(`Dify login failed: HTTP ${res.status}`, res.status)
  }

  const cookies = res.headers.getSetCookie?.() || []
  let access = ''
  let csrf = ''

  for (const cookie of cookies) {
    if (cookie.startsWith('access_token=')) {
      access = cookie.split('access_token=')[1].split(';')[0]
    }
    if (cookie.startsWith('csrf_token=')) {
      csrf = cookie.split('csrf_token=')[1].split(';')[0]
    }
  }

  if (!access || !csrf) {
    throw new DifyLoginError('Dify login succeeded but tokens missing from cookies')
  }

  return { access, csrf }
}

/**
 * Build headers for authenticated Dify console API calls.
 */
export function makeDifyHeaders(tokens: DifyTokens): HeadersInit {
  return {
    'Cookie': `access_token=${tokens.access}; csrf_token=${tokens.csrf}`,
    'X-CSRF-Token': tokens.csrf,
  }
}

/**
 * Login using env vars. Returns null if credentials are not configured.
 * Silently returns null on failure (for use in optional/startup contexts).
 */
export async function loginFromEnv(
  difyUrl?: string,
): Promise<DifyTokens | null> {
  const url = difyUrl || process.env.DIFY_API_URL || 'http://nginx:80'
  const email = process.env.DIFY_ADMIN_EMAIL
  const password = process.env.DIFY_ADMIN_PASSWORD

  if (!email || !password) return null

  try {
    return await loginToDify(url, email, password)
  } catch {
    return null
  }
}
