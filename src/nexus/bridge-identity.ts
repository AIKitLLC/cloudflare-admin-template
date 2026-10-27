/**
 * The identity header Nexus CRM trusts from this Worker (docs/adr/0001-nexus-crm-service-binding.md).
 * `v1.<base64url(json)>.<hex HMAC-SHA256 of "v1.<base64url>">`, signed with `NEXUS_BRIDGE_SECRET`.
 * Nexus verifies it in `src/platform/template-bridge.ts`; both sides must change together.
 */
export const NEXUS_IDENTITY_HEADER = 'x-nexus-identity'
export const NEXUS_IDENTITY_LIFETIME_MS = 60_000

export type NexusRole = 'owner' | 'admin' | 'member' | 'viewer'

export type NexusIdentity = {
  userId: string
  email: string
  role: NexusRole
  exp: number
}

const encoder = new TextEncoder()

export async function signNexusIdentity(identity: NexusIdentity, secret: string): Promise<string> {
  const body = `v1.${base64url(JSON.stringify(identity))}`
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)))
  return `${body}.${[...signature].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function base64url(value: string): string {
  let binary = ''
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
