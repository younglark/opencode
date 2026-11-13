export * as ReviewHandler from "./handler.js"

import { Effect, Schema } from "effect"
import type { ReviewContext } from "./context.js"
import type { ReviewController } from "./controller.js"
import { ReviewDecide } from "./decide.js"
import { ReviewFeedback } from "./feedback.js"
import { ReviewPage } from "./page.js"
import { ReviewState } from "./state.js"

/** What the server route supplies: plugin storage, the session and its diff, and a way to prompt it. */
export interface Deps {
  readonly storage: ReviewController.Storage
  readonly now: Effect.Effect<number>
  readonly session: (sessionID: string) => Effect.Effect<ReviewDecide.SessionView | undefined>
  readonly diff: (sessionID: string) => Effect.Effect<ReadonlyArray<ReviewPage.FileDiff>, unknown>
  readonly prompt: (input: {
    readonly sessionID: string
    readonly text: string
    readonly metadata: Record<string, unknown>
  }) => Effect.Effect<void, unknown>
  /** Title, original request and recent turns; omitted or failing leaves the page without that section's details. */
  readonly context?: (sessionID: string) => Effect.Effect<ReviewContext.Context | undefined, unknown>
}

export interface Response {
  readonly status: number
  readonly html: string
}

export interface Form {
  readonly t?: string | null
  readonly decision?: string | null
  readonly text?: string | null
  readonly comments?: ReadonlyArray<{ readonly file?: string | null; readonly text?: string | null }>
}

const decodeDecision = Schema.decodeUnknownOption(ReviewState.Decision)
const json = (value: unknown) => value as Schema.Json

export function make(deps: Deps) {
  /** Adds or drops one id in the session's open list, keeping the others. */
  const setOpen = Effect.fn("ReviewHandler.setOpen")(function* (sessionID: string, reviewID: string, open: boolean) {
    const key = ReviewState.OPEN_PREFIX + sessionID
    const ids = ReviewState.openIDs(yield* deps.storage.get(key)).filter((id) => id !== reviewID)
    if (open) ids.push(reviewID)
    if (ids.length === 0) yield* deps.storage.remove(key)
    else yield* deps.storage.set(key, json(ids))
  })

  const load = Effect.fn("ReviewHandler.load")(function* (reviewID: string, token: string | undefined | null) {
    const review = ReviewState.review(yield* deps.storage.get(ReviewState.REVIEW_PREFIX + reviewID))
    const session = review ? yield* deps.session(review.sessionID) : undefined
    const outcome = ReviewDecide.check({ review, token, now: yield* deps.now, session })
    return { review, outcome }
  })

  const view = Effect.fn("ReviewHandler.view")(function* (reviewID: string, token: string | undefined | null) {
    const { review, outcome } = yield* load(reviewID, token)
    if (outcome !== "ok" || !review || !token) return ReviewPage.outcome(outcome === "ok" ? "invalid" : outcome)
    const diff = yield* deps.diff(review.sessionID).pipe(
      Effect.map((diffs) => ({ diffs, error: undefined })),
      Effect.catchCause(() => Effect.succeed({ diffs: [], error: "改动暂时无法读取。" })),
    )
    const context = deps.context
      ? yield* deps.context(review.sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      : undefined
    return {
      status: 200,
      html: ReviewPage.approval({ review, token, diffs: diff.diffs, diffError: diff.error, context }),
    } satisfies Response
  })

  const submit = Effect.fn("ReviewHandler.submit")(function* (reviewID: string, form: Form) {
    const { review, outcome } = yield* load(reviewID, form.t)
    if (outcome !== "ok" || !review) return ReviewPage.outcome(outcome === "ok" ? "invalid" : outcome)
    const decision = decodeDecision(form.decision)
    if (decision._tag === "None") return { status: 400, html: ReviewPage.outcome("invalid").html }
    const now = yield* deps.now
    const fileComments = ReviewFeedback.comments(form.comments ?? [])
    // One-time: the token is spent before anything is written back, so a double tap cannot prompt twice.
    const closed: ReviewState.Review = {
      ...review,
      status: "submitted",
      decision: decision.value,
      closedAt: now,
      ...(form.text ? { feedback: form.text.slice(0, ReviewFeedback.MAX_TEXT) } : {}),
    }
    yield* deps.storage.set(ReviewState.REVIEW_PREFIX + review.id, json(closed))
    yield* setOpen(review.sessionID, review.id, false)
    const text = ReviewFeedback.prompt(decision.value, form.text ?? undefined, fileComments)
    if (text === undefined) return { status: 200, html: ReviewPage.submitted(decision.value) } satisfies Response
    const sent = yield* deps
      .prompt({ sessionID: review.sessionID, text, metadata: ReviewFeedback.metadata(review.id, decision.value) })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("review feedback could not be written back", { reviewID: review.id, cause }).pipe(
            Effect.as(false),
          ),
        ),
      )
    if (!sent) {
      // Give the link back so the phone can retry.
      yield* deps.storage.set(ReviewState.REVIEW_PREFIX + review.id, json(review))
      yield* setOpen(review.sessionID, review.id, true)
      return ReviewPage.failed()
    }
    return { status: 200, html: ReviewPage.submitted(decision.value) } satisfies Response
  })

  return { view, submit }
}
