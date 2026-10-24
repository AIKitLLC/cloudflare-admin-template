/**
 * Light entry for the Firebase native-client path. It runs in a constrained runtime (bundled for
 * workerd by scripts/firebase-client-runtime.mjs), so it must never reach first-admin-setup,
 * `payload` or `node:*` modules. Everything else goes through `./index`.
 */
export {
  authenticateFirebaseClient,
  createFirebaseClientAuthenticator,
  FirebaseAuthError,
  readFirebaseClientConfig,
  type FirebaseClientAuthenticator,
  type FirebaseClientConfig,
  type FirebaseClientEnv,
  type FirebaseClientIdentity,
} from './firebase-client'
export {
  createFirebaseClientRoute,
  firebaseClientOwnsRecord,
  firebaseClientQuotaKey,
  type FirebaseClientHandler,
  type FirebaseOwnedRecord,
} from './firebase-client-route'
