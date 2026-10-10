/**
 * Payload 3.82.1 builds `/api/access` and admin permission props by calling
 * collection access with exactly `{ id, data, req }` from `getEntityPermissions`.
 * Queries go through `executeAccess`, which also passes `isReadingStaticFile`.
 * Production bundles rename `getEntityPermissions`, so the argument shape is
 * the signal that survives minification. Any other shape still applies the
 * user id list.
 */
export function isPermissionPayloadCall(args: object): boolean {
  const keys = Object.keys(args).sort()
  return keys.length === 3 && keys[0] === 'data' && keys[1] === 'id' && keys[2] === 'req'
}
