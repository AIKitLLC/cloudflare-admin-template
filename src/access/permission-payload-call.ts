/**
 * Payload 3.91 builds `/api/access` and admin permission props by calling
 * collection access with exactly `{ id, collectionConfig, data, req }` from
 * `getEntityPermissions`. Queries go through `executeAccess`, which also passes
 * `isReadingStaticFile`. Production bundles rename `getEntityPermissions`, so
 * the argument shape is the signal that survives minification. Any other shape
 * still applies the user id list. Matching this shape must not grant an unscoped allow.
 */
export function isPermissionPayloadCall(args: object): boolean {
  const keys = Object.keys(args).sort()
  return (
    keys.length === 4 &&
    keys[0] === 'collectionConfig' &&
    keys[1] === 'data' &&
    keys[2] === 'id' &&
    keys[3] === 'req'
  )
}

/** The document id on a permission-payload call. Absent for collection-level access. */
export function permissionDocumentId(args: object): number | string | undefined {
  if (!isPermissionPayloadCall(args)) {
    return undefined
  }
  const id = (args as { id?: unknown }).id
  if (typeof id === 'number' && Number.isFinite(id)) {
    return id
  }
  if (typeof id === 'string' && id.length > 0) {
    return id
  }
  return undefined
}
