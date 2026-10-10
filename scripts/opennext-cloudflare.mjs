import { registerHooks } from 'node:module'

import { load } from './stub-worker-drizzle-kit-loader.mjs'
import { patchOpenNextInternalHost } from './patch-opennext-internal-host.mjs'

registerHooks({ load })

let patched = false
function patchHostAfterBuild(code) {
  if (patched || code) return
  if (!process.argv.includes('build')) return
  patched = true
  patchOpenNextInternalHost()
}

const exit = process.exit.bind(process)
process.exit = ((code) => {
  patchHostAfterBuild(code)
  return exit(code)
})

await import('../node_modules/@opennextjs/cloudflare/dist/cli/index.js')
patchHostAfterBuild(0)
