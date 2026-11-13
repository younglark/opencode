export * as ReviewToken from "./token.js"

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/** 32 random bytes, base64url. */
export function generate() {
  return randomBytes(32).toString("base64url")
}

export function hash(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

export function matches(token: string | undefined | null, expected: string) {
  if (!token) return false
  const actual = Buffer.from(hash(token))
  const wanted = Buffer.from(expected)
  return actual.length === wanted.length && timingSafeEqual(actual, wanted)
}

export function id() {
  return randomBytes(9).toString("base64url")
}
