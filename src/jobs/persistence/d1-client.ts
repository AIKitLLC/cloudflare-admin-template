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

export function d1(payload: Payload): D1Client {
  const client = (payload.db as { client?: D1Client }).client
  if (!client) {
    throw new Error('D1 binding is unavailable.')
  }
  return client
}

export function beginD1Budget(
  payload: Payload,
  limit: number,
): { end: () => void; used: () => number } {
  const client = (payload.db as { client?: { prepare: (query: string) => unknown } }).client
  if (!client) {
    throw new Error('D1 binding is unavailable.')
  }
  const original = client.prepare.bind(client)
  let used = 0
  client.prepare = (query: string) => {
    used += 1
    if (used > limit) {
      throw new Error('Scheduled job run reached the D1 subrequest budget.')
    }
    return original(query)
  }
  return {
    used: () => used,
    end: () => {
      client.prepare = original
    },
  }
}
