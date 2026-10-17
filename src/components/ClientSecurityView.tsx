import { headers } from 'next/headers'
import type { AdminViewServerProps } from 'payload'

import { isStoredClientSecurityOwner } from '@/auth/client-security-owner'
import { ClientSecurityPanel } from './ClientSecurityPanel'

/** Custom admin routes need their own authorization before mounting client readers. */
export async function ClientSecurityView({ initPageResult }: AdminViewServerProps) {
  const { payload } = initPageResult.req
  let allowed = false
  try {
    const { user } = await payload.auth({ headers: new Headers(await headers()) })
    allowed = await isStoredClientSecurityOwner(payload, user)
  } catch {
    // A missing session, failed user lookup, or auth outage must not render controls.
  }

  if (!allowed) {
    return (
      <section className="gutter" style={{ paddingBlock: '2rem' }}>
        <h1>Access denied</h1>
        <p>Only an authenticated owner can view or change client security settings.</p>
      </section>
    )
  }

  return <ClientSecurityPanel />
}
