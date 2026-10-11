import type { Payload } from 'payload'

type BoundStatement = {
  all: <T>() => Promise<{ results?: T[] }>
  bind: (...values: unknown[]) => BoundStatement
  first: <T>() => Promise<T | null>
  run: () => Promise<{ meta?: { changes?: number } }>
}

export type D1Client = {
  prepare: (query: string) => BoundStatement
}

export type D1Budget = {
  charge: (calls?: number) => void
  used: () => number
}

export function createD1Budget(limit: number): D1Budget {
  let used = 0
  return {
    used: () => used,
    charge(calls = 1) {
      used += calls
      if (used > limit) {
        throw new Error('Scheduled job run reached the D1 subrequest budget.')
      }
    },
  }
}

export function d1(payload: Payload, budget?: D1Budget): D1Client {
  const client = (payload.db as { client?: D1Client }).client
  if (!client) {
    throw new Error('D1 binding is unavailable.')
  }
  if (!budget) {
    return client
  }
  return {
    prepare(query: string) {
      budget.charge(1)
      return client.prepare(query)
    },
  }
}
