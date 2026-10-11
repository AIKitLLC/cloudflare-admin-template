import { USERS_SLUG } from '../constants'
import type { AccessGate } from '../types'

export const selfServiceGate: AccessGate = {
  name: 'self-service',
  async evaluate(context) {
    if (!context.options.selfService || !context.req.user) {
      return undefined
    }
    if (context.action !== 'read' && context.action !== 'update') {
      return undefined
    }
    if (
      context.collectionSlug !== USERS_SLUG &&
      context.req.user.collection !== context.collectionSlug
    ) {
      return undefined
    }
    return {
      id: {
        equals: context.req.user.id,
      },
    }
  },
}
