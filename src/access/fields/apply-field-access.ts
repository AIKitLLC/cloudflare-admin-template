import type { Payload, PayloadRequest } from 'payload'

import { collectionEnablesRbac } from '../options'
import { evaluateFieldAccess } from './evaluate-field-access'
import { walkPermissionedFields, type WalkableField } from './permissioned-field'

type FieldAccessArgs = {
  req: PayloadRequest
  id?: unknown
  doc?: { id?: unknown } | null
  data?: { id?: unknown } | null
}

type AccessFunction = (args: FieldAccessArgs) => boolean | Promise<boolean>

export function applyFieldAccess(payload: Payload): void {
  for (const collection of payload.config.collections) {
    if (!collectionEnablesRbac(collection.custom)) {
      continue
    }
    walkPermissionedFields(collection.fields as WalkableField[], (field, fieldPath) => {
      assignFieldAccess(collection.slug, field, fieldPath)
    })
  }
}

function assignFieldAccess(collectionSlug: string, field: WalkableField, fieldPath: string): void {
  if (!field.access) {
    field.access = {}
  }
  if (field.access.rbacApplied) {
    return
  }

  const previousCreate = field.access.create as AccessFunction | undefined
  const previousRead = field.access.read as AccessFunction | undefined
  const previousUpdate = field.access.update as AccessFunction | undefined

  field.access.create = (args: FieldAccessArgs) =>
    composeFieldAccess({
      previous: previousCreate,
      args,
      collectionSlug,
      fieldPath,
      mode: 'write',
    })
  field.access.read = (args: FieldAccessArgs) =>
    composeFieldAccess({
      previous: previousRead,
      args: { ...args, doc: args.doc ?? args.data },
      collectionSlug,
      fieldPath,
      mode: 'read',
    })
  field.access.update = (args: FieldAccessArgs) =>
    composeFieldAccess({
      previous: previousUpdate,
      args,
      collectionSlug,
      fieldPath,
      mode: 'write',
    })
  field.access.rbacApplied = true
}

async function composeFieldAccess(args: {
  previous: AccessFunction | undefined
  args: FieldAccessArgs
  collectionSlug: string
  fieldPath: string
  mode: 'read' | 'write'
}): Promise<boolean> {
  const allowed = await evaluateFieldAccess({
    req: args.args.req,
    collectionSlug: args.collectionSlug,
    fieldPath: args.fieldPath,
    mode: args.mode,
    id: args.args.id,
    doc: args.args.doc,
  })
  if (!allowed) {
    return false
  }
  if (args.previous) {
    return args.previous(args.args)
  }
  return true
}
