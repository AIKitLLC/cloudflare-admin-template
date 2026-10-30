import { createNexusRoute } from '@/nexus'

import { nexusServices } from '../../../nexus-services'

export const dynamic = 'force-dynamic'

const handle = createNexusRoute({ getServices: nexusServices })

export { handle as DELETE, handle as GET, handle as PATCH, handle as POST, handle as PUT }
