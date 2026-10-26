import { randomBytes } from 'node:crypto'

import type { APIRequestContext } from '@playwright/test'

import { api, type ApiResult } from './api'

/** A valid 1x1 PNG, so a test needs no fixture file. */
export const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082',
  'hex',
)

/** A file name no other test or retry uses (Payload renames a duplicate, so a fixed name is fragile). */
export function uniqueFilename(extension = 'png'): string {
  return `e2e-${randomBytes(4).toString('hex')}.${extension}`
}

/** `POST /api/media` as multipart. `alt` is left out of the payload when undefined. */
export async function uploadMedia(
  request: APIRequestContext,
  {
    token,
    filename = uniqueFilename(),
    alt,
    mimeType = 'image/png',
    buffer = PNG,
    ip,
  }: {
    token: string
    filename?: string
    alt?: string
    mimeType?: string
    buffer?: Buffer
    ip?: string
  },
): Promise<ApiResult> {
  return api(request, {
    method: 'POST',
    path: '/api/media',
    token,
    ip,
    multipart: {
      _payload: JSON.stringify(alt === undefined ? {} : { alt }),
      file: { name: filename, mimeType, buffer },
    },
  })
}
