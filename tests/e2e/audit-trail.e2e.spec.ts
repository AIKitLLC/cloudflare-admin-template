import { expect, test } from '@playwright/test'

import { e2eAdmin } from './helpers/admin'
import { superAdminRoleId, userWithRole } from './helpers/access'
import { api } from './helpers/api'
import { auditEntries, uploadMedia } from './helpers/media'
import { adminToken, createUser, uniqueEmail, uniqueIp } from './helpers/sign-in'

const PASSWORD = 'e2e-audit-user-password-123'

test.describe('The audit trail', () => {
  test("a user's create, update and delete each leave one entry", async ({ request }) => {
    const since = new Date().toISOString()
    const ip = uniqueIp()
    const token = adminToken()
    const created = await api(request, {
      method: 'POST',
      path: '/api/users',
      token,
      ip,
      data: { email: uniqueEmail('audited'), password: PASSWORD },
    })
    const id = created.body.doc.id as number
    await api(request, {
      method: 'PATCH',
      path: `/api/users/${id}`,
      token,
      ip,
      data: { email: uniqueEmail('audited-renamed') },
    })
    await api(request, { method: 'DELETE', path: `/api/users/${id}`, token, ip })

    const entries = await auditEntries(request, { collection: 'users', id, since })

    expect(entries.map((entry) => entry.action)).toEqual(['CREATE', 'UPDATE', 'DELETE'])
    for (const entry of entries) {
      expect(entry.actorEmail).toBe(e2eAdmin.email)
      expect(entry.ipAddress).toBe(ip)
    }
    expect(entries[0].summary).toMatch(new RegExp(`^CREATE users #${id} `))
    expect(entries[1].summary).toBe(`UPDATE users #${id} (email)`)
  })

  test('a Media upload and delete are recorded', async ({ request }) => {
    const since = new Date().toISOString()
    const ip = uniqueIp()
    const token = adminToken()
    const created = await uploadMedia(request, { token, alt: 'audited', ip })
    const id = created.body.doc.id as number
    await api(request, {
      method: 'PATCH',
      path: `/api/media/${id}`,
      token,
      ip,
      data: { alt: 'audited again' },
    })
    await api(request, { method: 'DELETE', path: `/api/media/${id}`, token, ip })

    const entries = await auditEntries(request, { collection: 'media', id, since })

    expect(entries.map((entry) => entry.action)).toEqual(['CREATE', 'UPDATE', 'DELETE'])
    expect(entries.every((entry) => typeof entry.documentId === 'string')).toBe(true)
    expect(entries.every((entry) => entry.ipAddress === ip)).toBe(true)
    expect(entries.every((entry) => entry.actorEmail === e2eAdmin.email)).toBe(true)
  })

  test('secrets are redacted', async ({ request }) => {
    const since = new Date().toISOString()
    const id = await createUser(request, { email: uniqueEmail('secret'), password: PASSWORD })

    const [entry] = await auditEntries(request, { collection: 'users', id, since })

    const byPath = Object.fromEntries(
      entry.changes.map((change: { path: string; newValue: unknown }) => [
        change.path,
        change.newValue,
      ]),
    )
    expect(byPath.password).toBe('[REDACTED]')
    expect(byPath.sessions).toBe('[REDACTED]')
    expect(JSON.stringify(entry)).not.toContain(PASSWORD)
  })

  test('a refused write leaves no entry', async ({ request }) => {
    const since = new Date().toISOString()
    const editor = await userWithRole(request, [
      'users:read',
      'users:update',
      'users:readField:email',
    ])
    const target = await createUser(request, {
      email: uniqueEmail('protected'),
      password: PASSWORD,
      roles: [await superAdminRoleId(request)],
    })
    const before = await auditEntries(request, { collection: 'users', id: target, since })
    expect(before.map((entry) => entry.action)).toEqual(['CREATE'])

    const attempt = await api(request, {
      method: 'PATCH',
      path: `/api/users/${target}`,
      token: editor.token,
      data: { email: uniqueEmail('hijacked') },
    })

    expect(attempt.status).toBe(403)
    expect(await auditEntries(request, { collection: 'users', id: target, since })).toHaveLength(
      before.length,
    )
  })

  test('the audit trail is append-only', async ({ request }) => {
    const since = new Date().toISOString()
    const id = await createUser(request, { email: uniqueEmail('trail'), password: PASSWORD })
    const [entry] = await auditEntries(request, { collection: 'users', id, since })
    const reader = await userWithRole(request, [])

    const patch = await api(request, {
      method: 'PATCH',
      path: `/api/audit-logs/${entry.id}`,
      token: adminToken(),
      data: { summary: 'rewritten' },
    })
    const remove = await api(request, {
      method: 'DELETE',
      path: `/api/audit-logs/${entry.id}`,
      token: adminToken(),
    })
    const read = await api(request, { method: 'GET', path: '/api/audit-logs', token: reader.token })

    expect(patch.status).toBe(403)
    expect(remove.status).toBe(403)
    expect(read.status).toBe(403)
    const [still] = await auditEntries(request, { collection: 'users', id, since })
    expect(still.summary).toBe(entry.summary)
  })

  test('the Audit Logs screen lists an entry', async ({ page, request }) => {
    const id = await createUser(request, { email: uniqueEmail('listed'), password: PASSWORD })

    await page.goto('/admin/collections/audit-logs?limit=20&sort=-createdAt', {
      waitUntil: 'domcontentloaded',
    })

    await expect(
      page.getByRole('row', { name: new RegExp(`Create users ${id} ${e2eAdmin.email}`) }),
    ).toBeVisible()
  })
})
