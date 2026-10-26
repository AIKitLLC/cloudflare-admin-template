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
function adminToken(): string {
  const state = JSON.parse(readFileSync(adminStorageState, 'utf8')) as {
    cookies: { name: string; value: string }[]
  }
  const token = state.cookies.find((cookie) => cookie.name === 'payload-token')?.value
  if (!token) throw new Error(`No payload-token in ${adminStorageState}; did first-admin run?`)
  return token
}

/** Creates a user as the admin. Sent as a JWT header because the Secure cookie is not sent over http. */
export async function createUser(request: APIRequestContext, user: Credentials): Promise<void> {
  const response = await request.post('/api/users', {
    headers: { authorization: `JWT ${adminToken()}` },
    data: user,
  })
  if (response.status() !== 201) {
    throw new Error(`Creating ${user.email} answered ${response.status()}: ${await response.text()}`)
  }
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
  const body = (await response.json()) as {
    message?: string
    token?: string
    errors?: { message: string }[]
  }
  return {
    status: response.status(),
    message: body.errors?.[0]?.message ?? body.message ?? '',
    token: body.token,
  }
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
