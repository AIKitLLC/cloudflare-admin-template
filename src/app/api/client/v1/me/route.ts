import { getCloudflareContext } from '@opennextjs/cloudflare'

import type { FirebaseClientEnv } from '@/auth/firebase-client'
import { createFirebaseClientRoute } from '@/auth/firebase-client-route'

export const dynamic = 'force-dynamic'

/** Native client example: headers authenticate the caller; there is no body-supplied UID. */
export const GET = createFirebaseClientRoute(
  (_request, principal) => Response.json({ principal }),
  {
    getEnv: async () => {
      const { env } = await getCloudflareContext({ async: true })
      return env as CloudflareEnv & FirebaseClientEnv
    },
  },
)
