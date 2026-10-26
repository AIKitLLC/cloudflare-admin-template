import type { APIRequestContext } from '@playwright/test'

type Args = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  /** Sent as `Authorization: JWT`; the Secure session cookie is not sent over http. */
  token?: string
  /** Sent as `cf-connecting-ip`. */
  ip?: string
  data?: unknown
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
  const headers: Record<string, string> = {}
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
