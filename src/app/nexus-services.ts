import { getCloudflareContext } from '@opennextjs/cloudflare'
import { getPayload } from 'payload'

import config from '@/payload.config'

/** Payload plus the optional Nexus CRM binding and bridge secret (docs/adr/0001-nexus-crm-service-binding.md). */
export async function nexusServices() {
  const { env } = await getCloudflareContext({ async: true })
  const nexusEnv = env as typeof env & { NEXUS?: Fetcher; NEXUS_BRIDGE_SECRET?: string }
  return {
    payload: await getPayload({ config }),
    nexus: nexusEnv.NEXUS,
    secret: nexusEnv.NEXUS_BRIDGE_SECRET,
  }
}
