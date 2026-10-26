import { APIError, type CollectionBeforeOperationHook } from 'payload'

/** Shortest password any user may set, through setup, the API, the admin screens or a reset. */
export const USER_PASSWORD_MIN_LENGTH = 12
/** Longest accepted password. Bounds the work spent hashing an oversized request. */
export const USER_PASSWORD_MAX_LENGTH = 256

export const USER_PASSWORD_LENGTH_MESSAGE = `The password must be between ${USER_PASSWORD_MIN_LENGTH} and ${USER_PASSWORD_MAX_LENGTH} characters.`

/** True for a string of USER_PASSWORD_MIN_LENGTH to USER_PASSWORD_MAX_LENGTH characters. */
export function isValidUserPassword(password: unknown): password is string {
  return (
    typeof password === 'string' &&
    password.length >= USER_PASSWORD_MIN_LENGTH &&
    password.length <= USER_PASSWORD_MAX_LENGTH
  )
}

/** Returns the password, or throws a 400 when it is outside the allowed length. */
export function validateUserPassword(password: unknown): string {
  if (!isValidUserPassword(password)) throw new APIError(USER_PASSWORD_LENGTH_MESSAGE, 400)
  return password
}

const PASSWORD_OPERATIONS = new Set(['create', 'update', 'updateByID', 'resetPassword'])

/**
 * `users` beforeOperation hook. Payload runs it before resetPassword looks up the token, so a
 * rejected reset leaves the token unused and still valid. Runs for create, update, updateByID
 * and resetPassword whenever the request carries a password.
 */
export const enforceUserPasswordPolicy: CollectionBeforeOperationHook = ({ args, operation }) => {
  if (!PASSWORD_OPERATIONS.has(operation)) return args
  const data = (args as { data?: unknown }).data
  if (!data || typeof data !== 'object' || !Object.hasOwn(data, 'password')) return args
  const password = (data as { password?: unknown }).password
  if (password === undefined || password === null) return args
  validateUserPassword(password)
  return args
}
