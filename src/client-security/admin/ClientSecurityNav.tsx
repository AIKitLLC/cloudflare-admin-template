import Link from 'next/link'
import type { Payload } from 'payload'

import { isStoredClientSecurityOwner } from '@/auth'

export async function ClientSecurityNav({ payload, user }: { payload: Payload; user: unknown }) {
  if (!(await isStoredClientSecurityOwner(payload, user))) return null
  return <Link href="/admin/client-security">Client Auth &amp; Rate limits</Link>
}
