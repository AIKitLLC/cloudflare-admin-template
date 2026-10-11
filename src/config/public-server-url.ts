const LOCAL_SERVER_URL = 'http://localhost:3000'

export function resolvePublicServerURL(env: {
  configuredURL: string | undefined
  isCLI: boolean
  nextPhase: string | undefined
  nodeEnv: string | undefined
}): string {
  const configured = env.configuredURL?.trim() ?? ''
  const isProduction = env.nodeEnv === 'production'
  const isNextProductionBuild = env.nextPhase === 'phase-production-build'
  if (isProduction && !env.isCLI && !isNextProductionBuild && !configured) {
    throw new Error(
      'PAYLOAD_PUBLIC_SERVER_URL is required in production. Set it to the public https origin of this Worker, for example https://admin.example.com. Without it, admin sessions, CSRF, and media URLs fall back to localhost.',
    )
  }
  return configured || LOCAL_SERVER_URL
}
