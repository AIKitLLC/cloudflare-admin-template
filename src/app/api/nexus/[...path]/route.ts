import { getCloudflareContext } from '@opennextjs/cloudflare'
import { getPayload } from 'payload'

import config from '@/payload.config'
import { createNexusRoute } from '@/nexus'

export const dynamic = 'force-dynamic'

const handle = createNexusRoute({
  getServices: async () => {
    const { env } = await getCloudflareContext({ async: true })
    const nexusEnv = env as typeof env & { NEXUS?: Fetcher; NEXUS_BRIDGE_SECRET?: string }
    return {
      payload: await getPayload({ config }),
      nexus: nexusEnv.NEXUS,
      secret: nexusEnv.NEXUS_BRIDGE_SECRET,
    }
  },
})

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT }
