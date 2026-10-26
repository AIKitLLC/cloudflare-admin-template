import type { APIRequestContext } from '@playwright/test'

type Args = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  /**
   * Sent as `Authorization: JWT`. The call never carries a session cookie (see below), so a token
   * alone decides who is calling and no token means anonymous.
   */
  token?: string
  /** Sent as `cf-connecting-ip`. */
  ip?: string
  data?: unknown
  /** Extra request headers, for example `origin`. */
  headers?: Record<string, string>
  multipart?: Record<
    string,
    string | number | boolean | { name: string; mimeType: string; buffer: Buffer }
  >
}

export type ApiResult = {
  status: number
  /** `errors[0].message`, else `error`, else `message`, else ''. */
  message: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any
}

/** One REST call. A body that is not JSON (an HTML 500, a file) throws with the status and the start of the text. */
export async function api(request: APIRequestContext, args: Args): Promise<ApiResult> {
  // Playwright's request client sends a `Secure` cookie to `localhost`, so a session left in its jar
  // (a storage state, or an earlier sign-in in the same test) would authenticate a call that is
  // meant to be anonymous or to act as the token's user. An explicit cookie header, even an empty
  // one, stops it adding the jar.
  const headers: Record<string, string> = { cookie: '', ...args.headers }
  const headers: Record<string, string> = { ...args.headers }
  if (args.token) headers.authorization = `JWT ${args.token}`
  if (args.ip) headers['cf-connecting-ip'] = args.ip
  const response = await request.fetch(args.path, {
    method: args.method,
    headers,
    data: args.data,
    multipart: args.multipart,
  })
  const text = await response.text()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any
  try {
    body = text === '' ? null : JSON.parse(text)
  } catch {
    throw new Error(
      `${args.method} ${args.path} answered ${response.status()} with: ${text.slice(0, 500)}`,
    )
  }
  return {
    status: response.status(),
    message: body?.errors?.[0]?.message ?? body?.error ?? body?.message ?? '',
    body,
  }
}
