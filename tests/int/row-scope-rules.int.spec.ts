// @vitest-environment node
import { describe, expect, it } from 'vitest'

import { SCOPE_ASSIGNMENT_ERROR, SCOPE_CYCLE_ERROR } from '@/scope/errors'
import { assignmentsWithinScope } from '@/scope/guards/assignments-within-scope'
import { mergeScopeField } from '@/scope/guards/merge-scope-field'
import { isScopeWithin } from '@/scope/guards/is-scope-within'
import { resolveEffectiveScope } from '@/scope/resolve/resolve-effective-scope'
import { ScopeTree } from '@/scope/tree/scope-tree'
import type { ScopeCatalog } from '@/scope/types'
import type { DirectScope } from '@/scope/where/direct-scope'
import { collapseCoveredIds } from '@/scope/where/collapse-covered-ids'
import { whereForBinding } from '@/scope/where/where-for-binding'

describe('row scope rules', () => {
  it('closes descendants and implies branches from an organization assignment', () => {
    const scope = resolveEffectiveScope(catalog(), {
      organizationIds: ['west'],
      branchIds: [],
      dataClassIds: ['sensitive'],
    })
    expect(ids(scope.grantableOrganizationIds)).toEqual(['west', 'west-child'])
    expect(ids(scope.organizationIds)).toEqual(['west', 'west-child'])
    expect(ids(scope.branchIds)).toEqual(['west-child-branch', 'west-main', 'west-sub'])
    expect(ids(scope.dataClassIds)).toEqual(['pii', 'sensitive'])
    expect(scope.grantableOrganizationIds.has('east')).toBe(false)
    expect(scope.dataClassIds.has('public')).toBe(false)
  })

  it('keeps a branch assignment from inheriting sibling branches or ancestor organizations', () => {
    const scope = resolveEffectiveScope(catalog(), {
      organizationIds: [],
      branchIds: ['west-sub'],
      dataClassIds: ['pii'],
    })
    expect(ids(scope.grantableOrganizationIds)).toEqual([])
    expect(ids(scope.organizationIds)).toEqual(['west'])
    expect(ids(scope.branchIds)).toEqual(['west-sub'])
    expect(ids(scope.dataClassIds)).toEqual(['pii'])
    expect(
      isScopeWithin(
        scope,
        resolveEffectiveScope(catalog(), {
          organizationIds: ['west'],
          branchIds: [],
          dataClassIds: ['sensitive'],
        }),
      ),
    ).toBe(true)
    expect(
      isScopeWithin(
        resolveEffectiveScope(catalog(), {
          organizationIds: ['west'],
          branchIds: [],
          dataClassIds: [],
        }),
        scope,
      ),
    ).toBe(false)
  })

  it('rejects a parent cycle, a self parent, an unknown parent, and a chain past the depth cap', () => {
    const parents = new Map<string, string | undefined>([
      ['west', undefined],
      ['west-child', 'west'],
    ])
    const tree = new ScopeTree(parents)
    expect(() => tree.assertParentDoesNotCycle('west', 'west-child')).toThrow(SCOPE_CYCLE_ERROR)
    expect(() => tree.assertParentDoesNotCycle('west', 'west')).toThrow(SCOPE_CYCLE_ERROR)
    expect(() => tree.assertParentDoesNotCycle('west-child', 'missing')).toThrow(SCOPE_CYCLE_ERROR)
    expect(() => tree.assertParentDoesNotCycle('west-child', 'west')).not.toThrow()

    const deep = new Map<string, string | undefined>()
    for (let index = 0; index < 40; index += 1) {
      deep.set(String(index), index === 0 ? undefined : String(index - 1))
    }
    expect(() => new ScopeTree(deep).assertParentDoesNotCycle(undefined, '39')).toThrow(
      SCOPE_CYCLE_ERROR,
    )
  })

  it('preserves scope ids the actor cannot hold and refuses new ids outside that scope', () => {
    expect(
      ids(mergeScopeField(new Set(['east', 'west']), new Set(['west']), new Set(['west']))),
    ).toEqual(['east', 'west'])
    expect(
      ids(
        mergeScopeField(
          new Set(['east', 'west']),
          new Set(['west-child']),
          new Set(['west', 'west-child']),
        ),
      ),
    ).toEqual(['east', 'west-child'])
    expect(() => mergeScopeField(new Set(['west']), new Set(['east']), new Set(['west']))).toThrow(
      SCOPE_ASSIGNMENT_ERROR,
    )
  })

  it('builds a match-nothing constraint when a dimension is empty and matches descendants by path', () => {
    const nothing = { and: [{ id: { exists: true } }, { id: { exists: false } }] }
    const empty = whereForBinding(
      { organizationField: 'organization', branchField: 'branch', dataClassField: 'dataClass' },
      direct(),
      'read',
    )
    expect(empty).toEqual({
      and: [nothing, nothing, nothing],
    })

    const branchOnly = direct({
      branchIds: ['west-sub'],
      branchOrganizationIds: ['west'],
    })
    const scoped = whereForBinding({ dimension: 'organization' }, branchOnly, 'update')
    expect(scoped).toEqual(nothing)

    const readable = whereForBinding({ dimension: 'organization' }, branchOnly, 'read')
    expect(readable).toEqual({ id: { in: ['west'] } })

    const inherited = whereForBinding(
      { dimension: 'organization' },
      direct({ organizationIds: ['west'] }),
      'read',
    )
    expect(inherited).toEqual({ scopePath: { contains: '/west/' } })

    const record = whereForBinding(
      { organizationField: 'organization', branchField: 'branch', dataClassField: 'dataClass' },
      direct({
        organizationIds: ['west'],
        branchIds: ['west-main'],
        dataClassIds: ['sensitive'],
      }),
      'read',
    )
    expect(record).toEqual({
      and: [
        { 'organization.scopePath': { contains: '/west/' } },
        {
          or: [
            { 'branch.scopePath': { contains: '/west-main/' } },
            { 'branch.organization.scopePath': { contains: '/west/' } },
          ],
        },
        { 'dataClass.scopePath': { contains: '/sensitive/' } },
      ],
    })
  })

  it('drops an assignment whose ancestor is already assigned', () => {
    const parents = new Map<string, string | undefined>([
      ['west', undefined],
      ['west-child', 'west'],
      ['east', undefined],
    ])
    expect(collapseCoveredIds(['west', 'west-child', 'east'], parents).sort()).toEqual([
      'east',
      'west',
    ])
    expect(collapseCoveredIds(['west-child'], parents)).toEqual(['west-child'])
  })

  it('hides a user who holds any assignment outside the actor scope', () => {
    const actor = resolveEffectiveScope(catalog(), {
      organizationIds: ['west'],
      branchIds: [],
      dataClassIds: ['sensitive'],
    })
    expect(
      assignmentsWithinScope(
        { organizations: ['west-child'], branches: [], dataClasses: ['pii'] },
        actor,
      ),
    ).toBe(true)
    expect(assignmentsWithinScope({}, actor)).toBe(false)
    expect(
      assignmentsWithinScope(
        { organizations: ['east'], branches: [], dataClasses: ['sensitive'] },
        actor,
      ),
    ).toBe(false)
    expect(
      assignmentsWithinScope(
        { organizations: ['west'], branches: [], dataClasses: ['public'] },
        actor,
      ),
    ).toBe(false)
  })
})

function direct(overrides: Partial<DirectScope> = {}): DirectScope {
  return {
    organizationIds: [],
    branchIds: [],
    branchOrganizationIds: [],
    dataClassIds: [],
    ...overrides,
  }
}

function catalog(): ScopeCatalog {
  return {
    organizations: new Map([
      ['west', { id: 'west' }],
      ['west-child', { id: 'west-child', parentId: 'west' }],
      ['east', { id: 'east' }],
    ]),
    branches: new Map([
      ['west-main', { id: 'west-main', organizationId: 'west' }],
      ['west-sub', { id: 'west-sub', parentId: 'west-main', organizationId: 'west' }],
      ['west-child-branch', { id: 'west-child-branch', organizationId: 'west-child' }],
      ['east-main', { id: 'east-main', organizationId: 'east' }],
    ]),
    dataClasses: new Map([
      ['sensitive', { id: 'sensitive' }],
      ['pii', { id: 'pii', parentId: 'sensitive' }],
      ['public', { id: 'public' }],
    ]),
  }
}

function ids(values: ReadonlySet<string>): string[] {
  return [...values].sort()
}
