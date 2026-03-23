import { describe, it, expect, vi, beforeEach } from 'vitest'
import { loginToDify, makeDifyHeaders, loginFromEnv, DifyLoginError } from '@/lib/dify-client'

function mockFetchResponse(ok: boolean, cookies: string[], status = 200) {
  return vi.spyOn(global, 'fetch').mockResolvedValueOnce({
    ok,
    status,
    headers: { getSetCookie: () => cookies },
  } as any)
}

describe('loginToDify', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('extracts access and csrf tokens from Set-Cookie headers', async () => {
    mockFetchResponse(true, [
      'access_token=abc123; Path=/; HttpOnly',
      'csrf_token=def456; Path=/',
    ])
    const result = await loginToDify('http://localhost', 'a@b.com', 'pass')
    expect(result).toEqual({ access: 'abc123', csrf: 'def456' })
  })

  it('base64-encodes the password', async () => {
    const spy = mockFetchResponse(true, [
      'access_token=a; Path=/',
      'csrf_token=b; Path=/',
    ])
    await loginToDify('http://localhost', 'a@b.com', 'mypass')
    const body = JSON.parse(spy.mock.calls[0][1]?.body as string)
    expect(body.password).toBe(Buffer.from('mypass').toString('base64'))
  })

  it('posts to /console/api/login', async () => {
    const spy = mockFetchResponse(true, [
      'access_token=a; Path=/',
      'csrf_token=b; Path=/',
    ])
    await loginToDify('http://dify:8080', 'a@b.com', 'pass')
    expect(spy.mock.calls[0][0]).toBe('http://dify:8080/console/api/login')
  })

  it('throws DifyLoginError on HTTP failure', async () => {
    mockFetchResponse(false, [], 401)
    await expect(loginToDify('http://localhost', 'a@b.com', 'wrong'))
      .rejects.toThrow(DifyLoginError)
  })

  it('includes status code in error', async () => {
    mockFetchResponse(false, [], 403)
    try {
      await loginToDify('http://localhost', 'a@b.com', 'wrong')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(DifyLoginError)
      expect((e as DifyLoginError).statusCode).toBe(403)
    }
  })

  it('throws when cookies are missing', async () => {
    mockFetchResponse(true, [])
    await expect(loginToDify('http://localhost', 'a@b.com', 'pass'))
      .rejects.toThrow('tokens missing')
  })

  it('throws when only access_token is present', async () => {
    mockFetchResponse(true, ['access_token=abc; Path=/'])
    await expect(loginToDify('http://localhost', 'a@b.com', 'pass'))
      .rejects.toThrow('tokens missing')
  })
})

describe('makeDifyHeaders', () => {
  it('returns Cookie and X-CSRF-Token headers', () => {
    const headers = makeDifyHeaders({ access: 'tok', csrf: 'crf' })
    expect(headers).toEqual({
      'Cookie': 'access_token=tok; csrf_token=crf',
      'X-CSRF-Token': 'crf',
    })
  })
})

describe('loginFromEnv', () => {
  beforeEach(() => { vi.restoreAllMocks() })

  it('returns null when env vars are missing', async () => {
    delete process.env.DIFY_ADMIN_EMAIL
    delete process.env.DIFY_ADMIN_PASSWORD
    const result = await loginFromEnv()
    expect(result).toBeNull()
  })

  it('returns null on login failure', async () => {
    process.env.DIFY_ADMIN_EMAIL = 'test@test.com'
    process.env.DIFY_ADMIN_PASSWORD = 'pass'
    mockFetchResponse(false, [], 401)
    const result = await loginFromEnv('http://localhost')
    expect(result).toBeNull()
  })

  it('returns tokens on success', async () => {
    process.env.DIFY_ADMIN_EMAIL = 'test@test.com'
    process.env.DIFY_ADMIN_PASSWORD = 'pass'
    mockFetchResponse(true, [
      'access_token=envtok; Path=/',
      'csrf_token=envcrf; Path=/',
    ])
    const result = await loginFromEnv('http://localhost')
    expect(result).toEqual({ access: 'envtok', csrf: 'envcrf' })
  })
})
