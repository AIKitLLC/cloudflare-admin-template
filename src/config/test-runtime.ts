/**
 * Wrangler config that integration tests hand to a `next dev` child so it shares their
 * isolated local D1/R2 state. Always undefined in production.
 */
export function testRuntimeWranglerConfig(env: {
  nodeEnv: string | undefined
  wranglerConfig: string | undefined
}): string | undefined {
  if (env.nodeEnv === 'production') return undefined
  return env.wranglerConfig || undefined
}

/** Persist path for the test runtime. Always undefined in production. */
export function testRuntimeStorageDir(env: {
  nodeEnv: string | undefined
  storageDir: string | undefined
}): string | undefined {
  if (env.nodeEnv === 'production') return undefined
  return env.storageDir || undefined
}
