import { SignJWT } from 'jose'

export const firebaseFixtureEnv = {
  FIREBASE_CLIENT_ENABLED: 'true',
  FIREBASE_PROJECT_ID: 'template-integration-fixture',
  FIREBASE_PROJECT_NUMBER: '123456789',
  FIREBASE_APP_IDS: '1:123456789:android:integration-fixture',
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function der(tag: number, ...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = concat(...parts)
  const length =
    body.length < 128
      ? [body.length]
      : body.length < 256
        ? [0x81, body.length]
        : [0x82, body.length >> 8, body.length & 255]
  return concat(new Uint8Array([tag, ...length]), body)
}

// Ephemeral self-signed fixture certificate: no checked-in private keys or Firebase credentials.
async function certificate(pair: CryptoKeyPair): Promise<string> {
  const bytes = (value: string) => new TextEncoder().encode(value)
  const algorithm = der(
    0x30,
    der(6, new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 1, 1, 0x0b])),
    der(5),
  )
  const name = der(
    0x30,
    der(
      0x31,
      der(0x30, der(6, new Uint8Array([0x55, 4, 3])), der(0x0c, bytes('Integration Fixture'))),
    ),
  )
  const validity = der(0x30, der(0x17, bytes('260101000000Z')), der(0x17, bytes('270101000000Z')))
  const tbs = der(
    0x30,
    der(0xa0, der(2, new Uint8Array([2]))),
    der(2, new Uint8Array([1])),
    algorithm,
    name,
    validity,
    name,
    new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)),
  )
  const signature = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, tbs),
  )
  const encoded = Buffer.from(
    der(0x30, tbs, algorithm, der(3, new Uint8Array([0]), signature)),
  ).toString('base64')
  return `-----BEGIN CERTIFICATE-----\n${encoded.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`
}

export async function createFirebaseFixture() {
  const generatePair = () =>
    crypto.subtle.generateKey(
      {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      },
      true,
      ['sign', 'verify'],
    ) as Promise<CryptoKeyPair>
  const [appPair, idPair] = await Promise.all([generatePair(), generatePair()])
  const appKid = 'integration-app-key'
  const idKid = 'integration-id-key'
  const jwk = {
    ...(await crypto.subtle.exportKey('jwk', appPair.publicKey)),
    kid: appKid,
    alg: 'RS256',
    use: 'sig',
  }
  const cert = await certificate(idPair)
  const sign = (claims: Record<string, unknown>, pair: CryptoKeyPair, kid: string) =>
    new SignJWT(claims).setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid }).sign(pair.privateKey)
  return {
    jwks: { keys: [jwk] },
    certificates: { [idKid]: cert },
    async headers(overrides: Record<string, unknown> = {}, invalidSignature?: 'app' | 'id') {
      const now = Math.floor(Date.now() / 1000)
      const appCheck = await sign(
        {
          iss: `https://firebaseappcheck.googleapis.com/${firebaseFixtureEnv.FIREBASE_PROJECT_NUMBER}`,
          aud: [`projects/${firebaseFixtureEnv.FIREBASE_PROJECT_NUMBER}`],
          sub: firebaseFixtureEnv.FIREBASE_APP_IDS,
          iat: now - 10,
          exp: now + 3600,
        },
        invalidSignature === 'app' ? idPair : appPair,
        appKid,
      )
      const id = await sign(
        {
          iss: `https://securetoken.google.com/${firebaseFixtureEnv.FIREBASE_PROJECT_ID}`,
          aud: firebaseFixtureEnv.FIREBASE_PROJECT_ID,
          sub: 'integration-anonymous-uid',
          iat: now - 10,
          exp: now + 3600,
          auth_time: now - 30,
          firebase: { sign_in_provider: 'anonymous' },
          ...overrides,
        },
        invalidSignature === 'id' ? appPair : idPair,
        idKid,
      )
      return new Headers({ Authorization: `Bearer ${id}`, 'X-Firebase-AppCheck': appCheck })
    },
  }
}
