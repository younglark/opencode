export * as ReviewWaiters from "./waiters.js"

import type { ReviewState } from "./state.js"

/**
 * Feedback for a review whose `review_request` call is still blocked on it. The tool runs in the plugin and the
 * submit in the server layer of the same process (see `bridge.ts`), so a registry on `globalThis` joins them.
 */
export interface Delivery {
  readonly reviewID: string
  readonly decision: ReviewState.Decision
  readonly text: string
  /** Absolute path of `feedback.json`, when the page submitted structured feedback. */
  readonly feedback?: string
  readonly images: ReadonlyArray<{ readonly name: string; readonly path: string; readonly mime: string }>
}

export type Waiter = (delivery: Delivery) => void

const KEY = Symbol.for("opencode.review.waiters")
const registry = ((globalThis as { [KEY]?: Map<string, Waiter> })[KEY] ??= new Map())

/** Returns an unregister function that only removes this waiter. */
export function register(reviewID: string, waiter: Waiter) {
  registry.set(reviewID, waiter)
  return () => {
    if (registry.get(reviewID) === waiter) registry.delete(reviewID)
  }
}

/** Hands the feedback to a blocked call; false when none waits, so the caller writes it into the session. */
export function deliver(delivery: Delivery) {
  const waiter = registry.get(delivery.reviewID)
  if (!waiter) return false
  registry.delete(delivery.reviewID)
  waiter(delivery)
  return true
}

export function waiting(reviewID: string) {
  return registry.has(reviewID)
}
