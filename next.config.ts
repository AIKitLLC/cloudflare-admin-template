import { withPayload } from '@payloadcms/next/withPayload'

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Page data collection imports the Payload config, which opens the local D1
  // file. Parallel workers lock that same SQLite database.
  experimental: {
    cpus: 1,
  },
  images: {
    localPatterns: [
      {
        pathname: '/api/media/file/**',
      },
    ],
  },
  // Packages with Cloudflare Workers (workerd) specific code
  // Read more: https://opennext.js.org/cloudflare/howtos/workerd
  serverExternalPackages: ['jose', 'pg-cloudflare'],

  // `next build` on Next 16 defaults to Turbopack. Payload externalizes `drizzle-kit`
  // (a transitive dependency) and Turbopack emits a hashed require that OpenNext's
  // esbuild step cannot resolve. The webpack hook below is what this template uses,
  // so the Worker build runs `next build --webpack`.
  webpack: (webpackConfig: any) => {
    webpackConfig.resolve.extensionAlias = {
      '.cjs': ['.cts', '.cjs'],
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    }

    return webpackConfig
  },
}

export default withPayload(nextConfig, { devBundleServerPackages: false })
