import type { AuditAction, FieldChange } from '../types'

const PREVIEW_LIMIT = 5

export function buildChangeSummary(input: {
  action: AuditAction
  collectionSlug: string
  documentId: string
  changes: Pick<FieldChange, 'path'>[]
}): string {
  const preview = input.changes.slice(0, PREVIEW_LIMIT).map((change) => change.path)
  const remaining = input.changes.length - preview.length
  const fieldList =
    preview.length === 0
      ? ''
      : ` (${preview.join(', ')}${remaining > 0 ? `, +${remaining} more` : ''})`
  return `${input.action} ${input.collectionSlug} #${input.documentId}${fieldList}`
}
