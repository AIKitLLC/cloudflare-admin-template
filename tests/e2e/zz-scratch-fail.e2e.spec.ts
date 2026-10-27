import { expect, test } from '@playwright/test'

import { api } from './helpers/api'
import { adminToken } from './helpers/sign-in'

// Scratch: fails on purpose so CI runs the artifact redaction. Never merged.
test('scratch: a failing test that sent a token', async ({ request }) => {
  const token = adminToken()
  const me = await api(request, { method: 'GET', path: '/api/users/me', token })
  expect(me.status).toBe(200)
  expect(`token was ${token.slice(0, 10)}`).toBe('forced failure')
})
