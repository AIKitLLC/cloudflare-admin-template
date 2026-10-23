import { getCloudflareContext } from '@opennextjs/cloudflare'

import {
  cloudflareClientIp,
  createManagedFirebaseClientRoute,
} from '@/client-security'

export const dynamic = 'force-dynamic'

/** Native client example: headers authenticate the caller; there is no body-supplied UID. */
export const GET = createManagedFirebaseClientRoute(
  (_request, principal) => Response.json({ principal }),
  {
    getDatabase: async () => {
      const { env } = await getCloudflareContext({ async: true })
      return env.D1
    },
    getTrustedIp: async (request) => {
      const { cf } = await getCloudflareContext({ async: true })
      return cloudflareClientIp(request, cf)
    },
  },
)
