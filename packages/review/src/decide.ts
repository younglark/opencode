export * as ReviewDecide from "./decide.js"

import { ReviewState } from "./state.js"
import { ReviewToken } from "./token.js"

export type Outcome = "ok" | "invalid" | "used" | "expired" | "continued"

export interface SessionView {
  readonly busy?: number
  readonly idle?: number
}

/** Whether a phone may still act on a review. `session` is undefined when the session no longer exists. */
export function check(input: {
  readonly review: ReviewState.Review | undefined
  readonly token: string | undefined | null
  readonly now: number
  readonly session: SessionView | undefined
}): Outcome {
  const review = input.review
  if (!review || !ReviewToken.matches(input.token, review.tokenHash)) return "invalid"
  if (review.status === "submitted") return "used"
  if (review.status === "superseded") return "continued"
  if (input.now >= review.expiresAt) return "expired"
  if (!input.session) return "invalid"
  if (ReviewState.running(input.session) || ReviewState.marker(input.session) !== review.marker) return "continued"
  return "ok"
}
