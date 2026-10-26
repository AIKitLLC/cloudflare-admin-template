import assert from 'node:assert/strict'
import test from 'node:test'
import { APIError } from 'payload'

import { FIRST_ADMIN_PASSWORD_MIN_LENGTH } from '../../src/auth/first-admin-setup'
import {
  enforceUserPasswordPolicy,
  USER_PASSWORD_MAX_LENGTH,
  USER_PASSWORD_MIN_LENGTH,
  validateUserPassword,
} from '../../src/auth/password-policy'
import { usersAuthOptions, USERS_RESET_TOKEN_EXPIRATION_MS } from '../../src/auth/users-auth'
import { Users } from '../../src/collections/Users'

const rejected = (error: unknown) => error instanceof APIError && error.status === 400

test('the password bounds are 12 and 256, and first-admin setup uses the shared minimum', () => {
  assert.equal(USER_PASSWORD_MIN_LENGTH, 12)
  assert.equal(USER_PASSWORD_MAX_LENGTH, 256)
  assert.equal(FIRST_ADMIN_PASSWORD_MIN_LENGTH, USER_PASSWORD_MIN_LENGTH)
})

test('validateUserPassword accepts 12 to 256 characters', () => {
  for (const length of [12, 13, 64, 256]) {
    assert.equal(validateUserPassword('a'.repeat(length)), 'a'.repeat(length))
  }
})

test('validateUserPassword rejects shorter, longer and non-string passwords with a 400', () => {
  for (const value of ['', 'abc', 'a'.repeat(11), 'a'.repeat(257), 123456789012, null, undefined, {}]) {
    assert.throws(() => validateUserPassword(value), rejected, `value ${String(value)}`)
  }
})

const hook = (operation: string, data: unknown) =>
  enforceUserPasswordPolicy({ args: { data }, operation } as never)

test('the hook rejects a short password on every password-setting operation', () => {
  for (const operation of ['create', 'update', 'updateByID', 'resetPassword']) {
    assert.throws(() => hook(operation, { password: 'a'.repeat(11) }), rejected, operation)
    assert.doesNotThrow(() => hook(operation, { password: 'a'.repeat(12) }), operation)
  }
})

test('the hook leaves requests without a password and other operations alone', () => {
  assert.doesNotThrow(() => hook('update', { email: 'someone@example.com' }))
  assert.doesNotThrow(() => hook('update', undefined))
  assert.doesNotThrow(() => hook('login', { password: 'short' }))
})

test('the users collection runs the hook before every operation, and tokens last 60 minutes', () => {
  assert.ok(Users.hooks?.beforeOperation?.includes(enforceUserPasswordPolicy))
  assert.equal(USERS_RESET_TOKEN_EXPIRATION_MS, 60 * 60 * 1000)
  assert.equal(usersAuthOptions('test').forgotPassword?.expiration, USERS_RESET_TOKEN_EXPIRATION_MS)
})
