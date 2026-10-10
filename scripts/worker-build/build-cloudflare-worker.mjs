import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { inlineWorkerPreviewProps } from './inline-preview-props.mjs'

export function buildCloudflareWorker(args = process.argv.slice(2)) {
  const result = spawnSync('pnpm', ['exec', 'opennextjs-cloudflare', 'build', ...args], {
    stdio: 'inherit',
    env: process.env,
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
  inlineWorkerPreviewProps()
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildCloudflareWorker()
}
