import { getCloudflareContext } from '@opennextjs/cloudflare'
import { getPayload } from 'payload'

import config from '@/payload.config'
import { createClientSecurityAdminRoute } from '@/client-security'

export const dynamic = 'force-dynamic'
export const { GET, POST } = createClientSecurityAdminRoute({
  getServices: async () => {
    const { env } = await getCloudflareContext({ async: true })
    return { db: env.D1, payload: await getPayload({ config }) }
  },
})
