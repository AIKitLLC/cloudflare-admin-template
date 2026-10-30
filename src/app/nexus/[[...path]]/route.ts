import { createNexusAppRoute } from '@/nexus'

import { nexusServices } from '../../nexus-services'

export const dynamic = 'force-dynamic'

const handle = createNexusAppRoute({ getServices: nexusServices })

export { handle as GET, handle as HEAD }
