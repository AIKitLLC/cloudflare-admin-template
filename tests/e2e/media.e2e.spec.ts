import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test'

import { api } from './helpers/api'
import { PNG, uniqueFilename, uploadMedia } from './helpers/media'
import { adminToken } from './helpers/sign-in'

// Same as the users spec: the field error or the toast.
const SHOWN_REQUIRED = /This field is required\.|The following field is invalid: Alt/

const isMediaPost = (r: Response) =>
  new URL(r.url()).pathname === '/api/media' && r.request().method() === 'POST'

/** Attaches `filename` to the create screen, optionally fills `alt`, saves. */
async function uploadThroughScreen(
  page: Page,
  { filename, alt }: { filename: string; alt?: string },
): Promise<Response> {
  await page.goto('/admin/collections/media/create', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('form[data-form-ready="true"]')
  await page.setInputFiles('input[type="file"]', {
    name: filename,
    mimeType: 'image/png',
    buffer: PNG,
  })
  if (alt !== undefined) await page.fill('#field-alt', alt)
  const [response] = await Promise.all([
    page.waitForResponse(isMediaPost),
    page.click('#action-save'),
  ])
  return response
}

async function deleteThroughScreen(page: Page, id: number): Promise<Response> {
  await page.goto(`/admin/collections/media/${id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('form[data-form-ready="true"]')
  await page.locator('.doc-controls button.popup-button').first().click()
  await page.click('#action-delete')
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(`/api/media/${id}`) && r.request().method() === 'DELETE',
    ),
    page.click('#confirm-action'),
  ])
  return response
}

/** The file URL fetched with no session, as a visitor would. */
async function fetchFile(request: APIRequestContext, url: string) {
  const response = await request.get(url)
  return {
    status: response.status(),
    type: response.headers()['content-type'] ?? null,
    bytes: response.status() === 200 ? await response.body() : null,
  }
}

test.describe('Media through the admin screens', () => {
  test('uploads a file with alt from the create screen', async ({ page, request }) => {
    const filename = uniqueFilename()

    const response = await uploadThroughScreen(page, { filename, alt: 'a single pixel' })

    expect(response.status()).toBe(201)
    const { doc } = (await response.json()) as {
      doc: { id: number; url: string; filename: string }
    }
    expect(doc).toMatchObject({ filename, mimeType: 'image/png', filesize: PNG.length })
    const served = await fetchFile(request, doc.url)
    expect(served.status).toBe(200)
    expect(served.type).toContain('image/png')
    expect(served.bytes?.equals(PNG)).toBe(true)
  })

  test('refuses an upload without alt', async ({ page, request }) => {
    const response = await uploadThroughScreen(page, { filename: uniqueFilename() })

    expect(response.status()).toBe(400)
    await expect(page.getByText(SHOWN_REQUIRED).first()).toBeVisible()

    const viaApi = await uploadMedia(request, { token: adminToken() })
    expect(viaApi.status).toBe(400)
    expect(viaApi.body.errors[0].data.errors[0]).toMatchObject({
      path: 'alt',
      message: 'This field is required.',
    })
  })

  test('edits alt and refuses clearing it', async ({ page, request }) => {
    const created = await uploadMedia(request, { token: adminToken(), alt: 'first alt' })
    const id = created.body.doc.id as number

    await page.goto(`/admin/collections/media/${id}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('form[data-form-ready="true"]')
    await page.fill('#field-alt', 'second alt')
    const [saved] = await Promise.all([
      page.waitForResponse(
        (r) => new URL(r.url()).pathname === `/api/media/${id}` && r.request().method() === 'PATCH',
      ),
      page.click('#action-save'),
    ])
    expect(saved.status()).toBe(200)

    const cleared = await api(request, {
      method: 'PATCH',
      path: `/api/media/${id}`,
      token: adminToken(),
      data: { alt: '' },
    })
    expect(cleared.status).toBe(400)
    expect(cleared.body.errors[0].data.errors[0].message).toBe('This field is required.')
    const stored = await api(request, { method: 'GET', path: `/api/media/${id}` })
    expect(stored.body.alt).toBe('second alt')
  })

  test('deletes an upload and its file', async ({ page, request }) => {
    const created = await uploadMedia(request, { token: adminToken(), alt: 'short lived' })
    const { id, url } = created.body.doc as { id: number; url: string }
    expect((await fetchFile(request, url)).status).toBe(200)

    const response = await deleteThroughScreen(page, id)

    expect(response.status()).toBe(200)
    expect((await api(request, { method: 'GET', path: `/api/media/${id}` })).status).toBe(404)
    expect((await fetchFile(request, url)).status).toBe(404)
  })

  test('refuses HTML and a scripted SVG, and renames a duplicate filename', async ({ request }) => {
    const token = adminToken()
    const html = await uploadMedia(request, {
      token,
      alt: 'html',
      filename: uniqueFilename('html'),
      mimeType: 'text/html',
      buffer: Buffer.from('<script>alert(1)</script>'),
    })
    expect(html.status).toBe(400)
    expect(html.body.errors[0].data.errors[0].message).toContain(
      "File type 'text/html' not allowed",
    )

    const svg = await uploadMedia(request, {
      token,
      alt: 'svg',
      filename: uniqueFilename('svg'),
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
    })
    expect(svg.status).toBe(400)
    expect(svg.body.errors[0].data.errors[0].message).toBe(
      'SVG file contains potentially harmful content.',
    )

    const filename = uniqueFilename()
    const first = await uploadMedia(request, { token, alt: 'one', filename })
    const secondBytes = Buffer.concat([PNG, Buffer.from('second')])
    const second = await uploadMedia(request, { token, alt: 'two', filename, buffer: secondBytes })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(first.body.doc.filename).toBe(filename)
    expect(second.body.doc.filename).toBe(filename.replace('-pic.png', '-pic-1.png'))
    // The second upload must not have overwritten the first: each URL serves its own bytes.
    const firstFile = await request.get(first.body.doc.url)
    const secondFile = await request.get(second.body.doc.url)
    expect((await firstFile.body()).equals(PNG)).toBe(true)
    expect((await secondFile.body()).equals(secondBytes)).toBe(true)
  })
})
