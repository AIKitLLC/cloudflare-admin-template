import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** @opennextjs/cloudflare release whose `inlineLoadManifest` glob this patch matches. */
export const pinnedOpenNextCloudflareVersion = '1.20.11'

/** @opennextjs/aws release bundled by that Cloudflare package. The throw text lives there. */
export const pinnedOpenNextAwsVersion = '4.1.10'

const handlerPath = join(process.cwd(), '.open-next/server-functions/default/handler.mjs')
const previewPropsPath = join(process.cwd(), '.next/server/preview-props.json')

const loadManifestThrow = /throw new Error\(`Unexpected loadManifest\(\$\{(\w+)}\) call!`\);?/

/**
 * OpenNext inlines `*-manifest.json` into `loadManifest` and throws for anything else.
 * Next 16 also reads `.next/server/preview-props.json`, which that glob skips.
 * Insert a return for that one file. The identifier in the throw is minified, so match
 * the message from `@opennextjs/cloudflare@1.20.11` rather than a variable name.
 */
export function inlineWorkerPreviewProps() {
  assertPinnedOpenNextVersions()
  const previewProps = readFileSync(previewPropsPath, 'utf8').trim()
  JSON.parse(previewProps)
  const source = readFileSync(handlerPath, 'utf8')
  const patched = patchLoadManifestSource(source, previewProps)
  if (patched === source) return
  writeFileSync(handlerPath, patched)
}

export function patchLoadManifestSource(source, previewProps) {
  const marker = '.endsWith("/server/preview-props.json")'
  if (source.includes(marker)) return source
  if (!loadManifestThrow.test(source)) {
    throw new Error(
      `OpenNext handler is missing the loadManifest throw expected from @opennextjs/cloudflare@${pinnedOpenNextCloudflareVersion}. ` +
        'Update scripts/worker-build/inline-preview-props.mjs before bumping that package.',
    )
  }
  return source.replace(loadManifestThrow, (match, pathName) => {
    return `if (${pathName}.endsWith("/server/preview-props.json")) return ${previewProps}; ${match}`
  })
}

function readInstalledVersion(packageName) {
  const cloudflareDir = realpathSync(join(process.cwd(), 'node_modules/@opennextjs/cloudflare'))
  const packageJsonPath = join(cloudflareDir, packageJsonRelativePath(packageName))
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')).version
}

function packageJsonRelativePath(packageName) {
  if (packageName === '@opennextjs/cloudflare') return 'package.json'
  if (packageName === '@opennextjs/aws') return join('..', 'aws', 'package.json')
  throw new Error(`No installed package lookup for ${packageName}`)
}

function assertPinnedOpenNextVersions() {
  const cloudflareVersion = readInstalledVersion('@opennextjs/cloudflare')
  const awsVersion = readInstalledVersion('@opennextjs/aws')
  if (
    cloudflareVersion !== pinnedOpenNextCloudflareVersion ||
    awsVersion !== pinnedOpenNextAwsVersion
  ) {
    throw new Error(
      `Preview props patch is pinned to @opennextjs/cloudflare@${pinnedOpenNextCloudflareVersion} ` +
        `and @opennextjs/aws@${pinnedOpenNextAwsVersion}. Found ${cloudflareVersion} and ${awsVersion}.`,
    )
  }
}
