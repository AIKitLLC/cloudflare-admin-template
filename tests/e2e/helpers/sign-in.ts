import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

import type { APIRequestContext, Page } from '@playwright/test'

import { adminStorageState } from '../../../playwright.config'

type Credentials = { email: string; password: string }

const octet = () => randomBytes(1)[0]

/** A client address no other test uses, so the per-IP throttle counter is this test's own. */
export function uniqueIp(): string {
  return `10.${octet()}.${octet()}.${octet()}`
}

/** An address no other test or retry uses, so lockout state is this test's own. */
export function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}@example.com`
}

/** The admin session saved by the first-admin spec. */
export function adminToken(): string {
  const state = JSON.parse(readFileSync(adminStorageState, 'utf8')) as {
    cookies: { name: string; value: string }[]
  }
  const token = state.cookies.find((cookie) => cookie.name === 'payload-token')?.value
  if (!token) throw new Error(`No payload-token in ${adminStorageState}; did first-admin run?`)
  return token
}

type NewUser = Credentials & {
  roles?: number[]
  organizations?: number[]
  branches?: number[]
  dataClasses?: number[]
}

/** Creates a user as the admin and returns its id. Sent as a JWT header so the call does not depend on a cookie jar. */
export async function createUser(request: APIRequestContext, user: NewUser): Promise<number> {
  const response = await request.post('/api/users', {
    headers: { authorization: `JWT ${adminToken()}` },
    data: user,
  })
  if (response.status() !== 201) {
    throw new Error(
      `Creating ${user.email} answered ${response.status()}: ${await response.text()}`,
    )
  }
  return ((await response.json()) as { doc: { id: number } }).doc.id
}

/** One sign-in over the API from the given client address. */
export async function attemptSignIn(
  request: APIRequestContext,
  { email, password, ip }: Credentials & { ip: string },
): Promise<{ status: number; message: string; token: string | undefined }> {
  const response = await request.post('/api/users/login', {
    headers: { 'cf-connecting-ip': ip },
    data: { email, password },
  })
  // An HTML 500 from the Worker or D1 must not surface as a bare SyntaxError that hides the status.
  const text = await response.text()
  let body: { message?: string; token?: string; errors?: { message: string }[] }
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(
      `Sign-in for ${email} answered ${response.status()} with: ${text.slice(0, 500)}`,
    )
  }
  return {
    status: response.status(),
    message: body.errors?.[0]?.message ?? body.message ?? '',
    token: body.token,
  }
}

/** The signed-in user's email, or null. From the page, so it uses the browser's cookie jar (the session cookie is Secure). */
export async function currentEmail(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const me = await fetch('/api/users/me')
    const body = (await me.json()) as { user: { email: string } | null }
    return body.user?.email ?? null
  })
}

/**
 * Opens the login screen from the given client address and submits. Does not assert the
 * outcome. The address is set on the context, so every request from this page carries it and a
 * failed sign-in never spends the default 127.0.0.1 counter.
 */
export async function signInThroughUi(
  page: Page,
  { email, password, ip }: Credentials & { ip: string },
): Promise<void> {
  await page.context().setExtraHTTPHeaders({ 'cf-connecting-ip': ip })
  await page.goto('/admin/login')
  // Submitting before React hydrates posts the form to the page and never reaches the API.
  await page.waitForLoadState('networkidle')
  await page.locator('#field-email').first().fill(email)
  await page.locator('#field-password').fill(password)
  await page.click('button[type="submit"]')
}
