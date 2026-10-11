# Worker build

`pnpm deploy` builds this Next.js app with OpenNext and uploads a Cloudflare Worker. `main` could not complete that build. This note is the fix and how to check it.

## What failed

`package.json` `build` used to run `payload build`. Payload 3.82 has no `build` command. `opennextjs-cloudflare build` runs `pnpm build`, so it stopped there.

Next.js 16 runs Turbopack for `next build` unless `--webpack` is passed. Payload's `withPayload` externalizes `drizzle-kit`, a transitive dependency of `@payloadcms/db-d1-sqlite` that pnpm does not hoist. Turbopack then emits a hashed `drizzle-kit-<hash>/api` require. OpenNext's esbuild step cannot resolve that path. This template's `next.config.ts` already has a `webpack` hook, which Turbopack ignores.

`next build --webpack` avoids that hashed require. Two other build failures showed up once the command existed:

- The generated admin layout imported `generatePayloadViewport`, which `@payloadcms/next` 3.82 does not export.
- `r2Storage()` is a Payload plugin. The config passed it as `storage`, which is not a `Config` field, so `plugins` is where it belongs.
- `next build` sets `NODE_ENV=production`. The D1 binding is marked `"remote": true`, so a production platform proxy opens a Cloudflare session. The build uses the local proxy only while `NEXT_PHASE` is `phase-production-build`.
- Page data collection opens that same local D1 file. `experimental.cpus` is `1` so those workers do not lock SQLite.

## Preview props

Webpack gets OpenNext through the compile. The Worker still threw `Unexpected loadManifest(/.next/server/preview-props.json)` on the first request. Next 16 reads that file. `@opennextjs/cloudflare@1.20.10` (which depends on `@opennextjs/aws@4.1.9`) inlines `*-manifest.json` and throws for every other manifest. `preview-props.json` does not match that glob.

`scripts/worker-build/inline-preview-props.mjs` inserts one return for that path into `.open-next/server-functions/default/handler.mjs` after the OpenNext build. The script refuses to run if those two packages are not the pinned versions, because the throw text is not a public API. `pnpm build:worker` is the command that runs the OpenNext build and then that patch. `pnpm run deploy` and `pnpm preview` use it.

## Check

```bash
pnpm test:worker
```

That rebuilds the Worker, runs `wrangler deploy --dry-run` (it uploads nothing), deletes the local D1 state, applies `pnpm payload migrate`, and serves `/admin` and `/my-route` with `wrangler dev --local`. The local serve sets `PAYLOAD_PUBLIC_SERVER_URL` to `http://127.0.0.1:8791`. A production Worker throws on startup without that variable. The local D1 reset drops a dev-mode `payload-migrations` row (`batch` -1) that would otherwise make production startup call `process.exit(0)`.

A dry run of the integrated stack reported:

```text
Total Upload: 15840.19 KiB / gzip: 3632.12 KiB
```

Gzip is over 3 MiB. Deploy on the Workers Paid plan. Cloudflare's current script limit is 64 MiB uncompressed on every plan ([changelog, 4 September 2026](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/)). This bundle is under that. The Free plan still allows 10 ms of CPU per request ([limits](https://developers.cloudflare.com/workers/platform/limits/)), which is too small to render Payload.

## Stacked pull requests

- #11 changes `build` from `payload build` to `next build`. Drop that hunk on rebase. This branch already sets `next build --webpack`. The admin layout, `src/payload-css.d.ts`, and `tsconfig.json` on #11 match the typecheck fixes here. #11's `payload.config.ts` includes the same local-D1 guard for `next build`.
- #15 (`cursor/background-jobs-61a7`) wrapped esbuild to stub Turbopack's hashed `drizzle-kit` require. The integration branch drops that stub and the esbuild override. `scripts/worker-build/build-cloudflare-worker.mjs` keeps #18's preview-props inlining and then applies #15's host-header patch.
