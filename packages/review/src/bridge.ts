export * as ReviewBridge from "./bridge.js"

/**
 * A review the plugin opened, handed to whoever sends notifications. The plugin runs inside a Location and cannot
 * see the server's URLs (LAN or the OpenTunnel route), so the server layer registers the publisher that builds the
 * link and sends the webhooks. Plugin and server share one process; the registry lives on `globalThis` so a
 * duplicated module instance still finds it.
 */
export interface Ready {
  readonly reviewID: string
  readonly token: string
  readonly sessionID: string
  readonly title: string
  readonly summary: string
  readonly directory: string
}

export type Publisher = (review: Ready) => void

const KEY = Symbol.for("opencode.review.bridge")
type Registry = { publisher?: Publisher }
const registry = ((globalThis as { [KEY]?: Registry })[KEY] ??= {})

/** Returns an unregister function that only clears this publisher. */
export function register(publisher: Publisher) {
  registry.publisher = publisher
  return () => {
    if (registry.publisher === publisher) registry.publisher = undefined
  }
}

/** False when no server layer listens, for example in a test host. */
export function publish(review: Ready) {
  if (!registry.publisher) return false
  registry.publisher(review)
  return true
}
