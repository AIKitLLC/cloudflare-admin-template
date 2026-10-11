export type OpenNextWorkerModule = {
  BucketCachePurge: unknown
  DOQueueHandler: unknown
  DOShardedTagCache: unknown
  default: {
    fetch: (request: Request, env?: unknown, ctx?: unknown) => Promise<Response>
  }
}
