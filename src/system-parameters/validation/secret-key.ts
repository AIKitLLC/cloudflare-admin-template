const SECRET_SEGMENT =
  /(?:^|-)(?:secret|secrets|password|passwd|token|tokens|apikey|credential|credentials|privatekey)(?:-|$)/

const SECRET_KEY_PAIR = /(?:^|-)(?:api|access|private)-key(?:-|$)/

export function keyLooksLikeSecret(key: string): boolean {
  return SECRET_SEGMENT.test(key) || SECRET_KEY_PAIR.test(key)
}
