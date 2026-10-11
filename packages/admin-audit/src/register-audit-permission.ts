import { collectionEnablesRbac, registerCatalogContributor } from '@aikit/admin-rbac'

import { AUDIT_LOGS_SLUG } from './constants'

registerCatalogContributor({
  definitions(collections = []) {
    const auditLogs = collections.find((collection) => collection.slug === AUDIT_LOGS_SLUG)
    if (!auditLogs || collectionEnablesRbac(auditLogs.custom)) {
      return []
    }
    return [
      {
        key: 'audit-logs:read',
        label: 'Audit Log · Read',
        groupLabel: 'Audit Log',
        collectionSlug: AUDIT_LOGS_SLUG,
        action: 'read' as const,
      },
    ]
  },
})
