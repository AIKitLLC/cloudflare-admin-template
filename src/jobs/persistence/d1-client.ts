import type { Payload } from 'payload'

type BoundStatement = {
  all: <T>() => Promise<{ results?: T[] }>
  first: <T>() => Promise<T | null>
  run: () => Promise<{ meta?: { changes?: number } }>
}

export type D1Client = {
  prepare: (query: string) => {
    bind: (...values: unknown[]) => BoundStatement
  }
}

export function d1(payload: Payload): D1Client {
  const client = (payload.db as { client?: D1Client }).client
  if (!client) {
    throw new Error('D1 binding is unavailable.')
  }
  return client
}
