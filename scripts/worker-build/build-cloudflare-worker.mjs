import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { patchOpenNextInternalHost } from '../patch-opennext-internal-host.mjs'
import { inlineWorkerPreviewProps } from './inline-preview-props.mjs'

export function buildCloudflareWorker(args = process.argv.slice(2)) {
  const result = spawnSync('pnpm', ['exec', 'opennextjs-cloudflare', 'build', ...args], {
    stdio: 'inherit',
    env: process.env,
    // `pnpm` is a .cmd shim on Windows; without a shell spawnSync cannot find it.
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
  inlineWorkerPreviewProps()
  patchOpenNextInternalHost()
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildCloudflareWorker()
}
