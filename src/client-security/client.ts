/**
 * Light entry for the Firebase native-client route. It runs in a constrained runtime (bundled for
 * workerd by scripts/firebase-client-runtime.mjs), so it must not reach `admin-route` or the full
 * `auth` entry. Everything else goes through `./index`.
 */
export { cloudflareClientIp, createManagedFirebaseClientRoute } from './client-route'
