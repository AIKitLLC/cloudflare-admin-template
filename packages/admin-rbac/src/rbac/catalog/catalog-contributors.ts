import type { PermissionDefinition } from './permission-definition'

export type CatalogCollectionInput = {
  slug: string
  custom?: unknown
}

type CatalogContributor = {
  definitions: (collections?: CatalogCollectionInput[]) => PermissionDefinition[]
  suppressKeys?: () => string[]
}

const contributors: CatalogContributor[] = []
const extraActions: string[] = []

export function registerCatalogContributor(contributor: CatalogContributor): void {
  const already = contributors.some((current) => current.definitions === contributor.definitions)
  if (!already) {
    contributors.push(contributor)
  }
}

export function registerCatalogActions(actions: readonly string[]): void {
  for (const action of actions) {
    if (!extraActions.includes(action)) {
      extraActions.push(action)
    }
  }
}

export function registeredCatalogActions(): readonly string[] {
  return extraActions
}

export function extraCatalogDefinitions(
  collections?: CatalogCollectionInput[],
): PermissionDefinition[] {
  return contributors.flatMap((contributor) => contributor.definitions(collections))
}

export function suppressedPermissionKeys(): Set<string> {
  return new Set(contributors.flatMap((contributor) => contributor.suppressKeys?.() ?? []))
}
