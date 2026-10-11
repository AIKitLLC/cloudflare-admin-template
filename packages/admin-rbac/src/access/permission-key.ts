import type { PermissionAction } from './types'

export function collectionPermissionKey(collectionSlug: string, action: PermissionAction): string {
  return `${collectionSlug}:${action}`
}

export function fieldPermissionKey(
  collectionSlug: string,
  action: 'readField' | 'writeField',
  fieldPath: string,
): string {
  return `${collectionSlug}:${action}:${fieldPath}`
}

export function permissionKey(
  collectionSlug: string,
  action: PermissionAction,
  fieldPath?: string | null,
): string {
  if (fieldPath && (action === 'readField' || action === 'writeField')) {
    return fieldPermissionKey(collectionSlug, action, fieldPath)
  }
  return collectionPermissionKey(collectionSlug, action)
}
