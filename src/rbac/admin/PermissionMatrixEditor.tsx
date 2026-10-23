'use client'

import React, { useState } from 'react'

import type { PermissionMatrix } from '../matrix/matrix-types'
import { GRANT_ROUTE } from '../routes'

type PermissionMatrixEditorProps = {
  matrix: PermissionMatrix
  canEdit: boolean
  apiRoute: string
}

export function PermissionMatrixEditor({ matrix, canEdit, apiRoute }: PermissionMatrixEditorProps) {
  const [state, setState] = useState(matrix)
  const [message, setMessage] = useState<string | null>(null)
  const [pendingKey, setPendingKey] = useState<string | null>(null)

  async function toggle(roleId: number, permissionId: number, granted: boolean) {
    const cellKey = `${roleId}:${permissionId}`
    setPendingKey(cellKey)
    setMessage(null)
    const previous = state
    setState(updateGrant(state, roleId, permissionId, granted))
    try {
      const response = await fetch(`${apiRoute}${GRANT_ROUTE}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId, permissionId, granted }),
      })
      if (!response.ok) {
        const payload = (await response.json().catch((): null => null)) as { error?: string } | null
        throw new Error(payload?.error || 'The grant could not be saved.')
      }
    } catch (error) {
      setState(previous)
      setMessage(error instanceof Error ? error.message : 'The grant could not be saved.')
    } finally {
      setPendingKey(null)
    }
  }

  return (
    <div className="rbac-matrix">
      <h1>Permission matrix</h1>
      <p className="rbac-matrix__intro">
        Collection actions control whether a role can create, read, update, delete, or export
        records. Field read and field write control individual fields. A role needs the collection
        action and the field permission. Full-access roles bypass these checkboxes.
      </p>
      {message ? <p className="rbac-matrix__status">{message}</p> : null}
      {!canEdit ? (
        <p className="rbac-matrix__intro">
          You can inspect this matrix. Updating grants requires role-permission update access.
        </p>
      ) : null}
      <div className="rbac-matrix__table-wrap">
        <table>
          <thead>
            <tr>
              <th>Permission</th>
              {state.roles.map((role) => (
                <th className="rbac-matrix__check" key={role.id}>
                  {role.name}
                  {role.grantsFullAccess ? (
                    <span className="rbac-matrix__full">Full access</span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.groups.map((group) => (
              <React.Fragment key={group.collectionSlug}>
                <tr className="rbac-matrix__group">
                  <td colSpan={state.roles.length + 1}>{group.label}</td>
                </tr>
                {group.rows.map((row) => (
                  <tr key={row.permissionId}>
                    <td>
                      {row.label}
                      <span className="rbac-matrix__key">{row.key}</span>
                    </td>
                    {state.roles.map((role) => {
                      const locked = role.grantsFullAccess || !canEdit
                      const checked = Boolean(row.grantsByRoleId[String(role.id)])
                      const cellKey = `${role.id}:${row.permissionId}`
                      return (
                        <td className="rbac-matrix__check" key={role.id}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={locked || pendingKey === cellKey}
                            aria-label={`${role.name} ${row.label}`}
                            onChange={(event) =>
                              toggle(role.id, row.permissionId, event.target.checked)
                            }
                          />
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function updateGrant(
  matrix: PermissionMatrix,
  roleId: number,
  permissionId: number,
  granted: boolean,
): PermissionMatrix {
  return {
    ...matrix,
    groups: matrix.groups.map((group) => ({
      ...group,
      rows: group.rows.map((row) => {
        if (row.permissionId !== permissionId) {
          return row
        }
        return {
          ...row,
          grantsByRoleId: {
            ...row.grantsByRoleId,
            [String(roleId)]: granted,
          },
        }
      }),
    })),
  }
}
