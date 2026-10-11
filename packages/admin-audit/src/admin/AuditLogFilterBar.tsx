'use client'

import { useListQuery } from '@payloadcms/ui'
import { useSearchParams } from 'next/navigation'
import { type FormEvent } from 'react'

import { readAuditLogViewerFilters, toAuditLogWhere } from './auditLogViewerQuery'
import styles from './AuditLogFilterBar.module.css'

export function AuditLogFilterBar() {
  const searchParams = useSearchParams()
  const { handleWhereChange } = useListQuery()
  const applied = readAuditLogViewerFilters(searchParams)

  function pushFilters(filters: { recordId: string; collection: string; operator: string }) {
    void handleWhereChange(toAuditLogWhere(filters))
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    pushFilters({
      recordId: String(form.get('recordId') ?? ''),
      collection: String(form.get('collection') ?? ''),
      operator: String(form.get('operator') ?? ''),
    })
  }

  return (
    <form className={styles.bar} key={searchParams.toString()} onSubmit={onSubmit}>
      <p className={styles.intro}>
        Filter audit records by record ID, collection, and operator. A numeric operator matches
        the operator id. Any other value matches the operator email.
      </p>
      <label className={styles.field}>
        <span className={styles.label}>Record ID</span>
        <input
          className={styles.input}
          name="recordId"
          defaultValue={applied.recordId}
          placeholder="42"
          autoComplete="off"
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Collection</span>
        <input
          className={styles.input}
          name="collection"
          defaultValue={applied.collection}
          placeholder="users"
          autoComplete="off"
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>Operator</span>
        <input
          className={styles.input}
          name="operator"
          defaultValue={applied.operator}
          placeholder="admin@example.com"
          autoComplete="off"
        />
      </label>
      <div className={styles.actions}>
        <button className={`${styles.button} ${styles.primary}`} type="submit">
          Apply
        </button>
        <button
          className={styles.button}
          type="button"
          onClick={() => pushFilters({ recordId: '', collection: '', operator: '' })}
        >
          Clear
        </button>
      </div>
    </form>
  )
}
