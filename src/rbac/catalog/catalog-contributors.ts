import type { PermissionDefinition } from './permission-definition'

type CatalogContributor = {
  definitions: () => PermissionDefinition[]
  suppressKeys?: () => string[]
}

const contributors: CatalogContributor[] = []

export function registerCatalogContributor(contributor: CatalogContributor): void {
  const already = contributors.some((current) => current.definitions === contributor.definitions)
  if (!already) {
    contributors.push(contributor)
  }
}

export function extraCatalogDefinitions(): PermissionDefinition[] {
  return contributors.flatMap((contributor) => contributor.definitions())
}

export function suppressedPermissionKeys(): Set<string> {
  return new Set(contributors.flatMap((contributor) => contributor.suppressKeys?.() ?? []))
}
