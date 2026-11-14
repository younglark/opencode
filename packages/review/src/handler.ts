export * as ReviewHandler from "./handler.js"

import fs from "node:fs/promises"
import { Effect, Schema } from "effect"
import { ReviewAnnotator } from "./annotator.js"
import { ReviewAssets } from "./assets.js"
import { ReviewCustom } from "./custom.js"
import type { ReviewContext } from "./context.js"
import type { ReviewController } from "./controller.js"
import { ReviewDecide } from "./decide.js"
import { ReviewFeedback } from "./feedback.js"
import { ReviewPage } from "./page.js"
import { ReviewRequest } from "./request.js"
import { ReviewResult } from "./result.js"
import { ReviewState } from "./state.js"
import { ReviewWaiters } from "./waiters.js"

export interface Attachment {
  readonly name: string
  /** Absolute path on the server's disk. */
  readonly path: string
  readonly mime: string
}

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
    /** Images that go along with the text, e.g. numbered annotation renders. */
    readonly files?: ReadonlyArray<Attachment>
  }) => Effect.Effect<void, unknown>
  /** Title, original request and recent turns; omitted or failing leaves the page without that section's details. */
  readonly context?: (sessionID: string) => Effect.Effect<ReviewContext.Context | undefined, unknown>
  /** Review file storage (snapshots and submitted feedback); without it assets and structured submits are refused. */
  readonly root?: string
  /** Hands feedback to a blocked `review_request` call; defaults to the process-wide registry. */
  readonly deliver?: (delivery: ReviewWaiters.Delivery) => boolean
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

/** A structured submit's answer, as JSON for the page's script. */
export interface JsonResponse {
  readonly status: number
  readonly body: { readonly ok: boolean; readonly error?: string; readonly delivered?: "tool" | "message" | "none" }
}

export type AssetResponse =
  | { readonly type: "error"; readonly status: number }
  | {
      readonly type: "file"
      readonly path: string
      readonly mime: string
      readonly size: number
      /** Set for a byte range; the body is then exactly these bytes. */
      readonly bytes?: Uint8Array
      readonly status: 200 | 206
      readonly headers: Record<string, string>
    }

const decodeDecision = Schema.decodeUnknownOption(ReviewState.Decision)
const json = (value: unknown) => value as Schema.Json
const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/

/** The items a review shows: its request, or the session diff alone for reviews stored before requests existed. */
export function items(review: ReviewState.Review): ReadonlyArray<ReviewRequest.StoredItem> {
  return review.request?.items ?? [ReviewRequest.diffItem(review.id)]
}

export function make(deps: Deps) {
  const deliver = deps.deliver ?? ReviewWaiters.deliver

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

  const hasDiff = (review: ReviewState.Review) => items(review).some((item) => item.kind === "diff")

  const view = Effect.fn("ReviewHandler.view")(function* (reviewID: string, token: string | undefined | null) {
    const { review, outcome } = yield* load(reviewID, token)
    if (outcome !== "ok" || !review || !token) return ReviewPage.outcome(outcome === "ok" ? "invalid" : outcome)
    const diff = hasDiff(review)
      ? yield* deps.diff(review.sessionID).pipe(
          Effect.map((diffs) => ({ diffs, error: undefined })),
          Effect.catchCause(() => Effect.succeed({ diffs: [], error: "改动暂时无法读取。" })),
        )
      : { diffs: [], error: undefined }
    const context = deps.context
      ? yield* deps.context(review.sessionID).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      : undefined
    return {
      status: 200,
      html: ReviewPage.approval({ review, token, diffs: diff.diffs, diffError: diff.error, context }),
    } satisfies Response
  })

  /** Spends the token: the review is closed before anything is written back, so a double tap cannot prompt twice. */
  const spend = Effect.fn("ReviewHandler.spend")(function* (
    review: ReviewState.Review,
    decision: ReviewState.Decision,
    text: string | undefined,
  ) {
    const closed: ReviewState.Review = {
      ...review,
      status: "submitted",
      decision,
      closedAt: yield* deps.now,
      ...(text ? { feedback: text.slice(0, ReviewFeedback.MAX_TEXT) } : {}),
    }
    yield* deps.storage.set(ReviewState.REVIEW_PREFIX + review.id, json(closed))
    yield* setOpen(review.sessionID, review.id, false)
  })

  /** Gives the link back so the phone can retry. */
  const restore = Effect.fn("ReviewHandler.restore")(function* (review: ReviewState.Review) {
    yield* deps.storage.set(ReviewState.REVIEW_PREFIX + review.id, json(review))
    yield* setOpen(review.sessionID, review.id, true)
  })

  /**
   * Feedback goes to a `review_request` call still blocked on it, else into the session as a message. `stop` on an
   * idle / `now` review writes nothing back, as before; an agent asked for its review, so it always hears back.
   */
  const writeBack = Effect.fn("ReviewHandler.writeBack")(function* (
    review: ReviewState.Review,
    decision: ReviewState.Decision,
    text: string | undefined,
    images: ReadonlyArray<Attachment>,
    feedback?: string,
  ) {
    const message = text ?? "[Remote review] I reviewed your work. Please stop here; do not continue."
    if (deliver({ reviewID: review.id, decision, text: message, images, ...(feedback ? { feedback } : {}) }))
      return "tool" as const
    if (text === undefined && ReviewState.followsSession(review)) return "none" as const
    const sent = yield* deps
      .prompt({
        sessionID: review.sessionID,
        text: message,
        metadata: ReviewFeedback.metadata(review.id, decision),
        ...(images.length > 0 ? { files: images } : {}),
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("review feedback could not be written back", { reviewID: review.id, cause }).pipe(
            Effect.as(false),
          ),
        ),
      )
    return sent ? ("message" as const) : undefined
  })

  const submit = Effect.fn("ReviewHandler.submit")(function* (reviewID: string, form: Form) {
    const { review, outcome } = yield* load(reviewID, form.t)
    if (outcome !== "ok" || !review) return ReviewPage.outcome(outcome === "ok" ? "invalid" : outcome)
    const decision = decodeDecision(form.decision)
    if (decision._tag === "None") return { status: 400, html: ReviewPage.outcome("invalid").html }
    const fileComments = ReviewFeedback.comments(form.comments ?? [])
    yield* spend(review, decision.value, form.text ?? undefined)
    const text = ReviewFeedback.prompt(decision.value, form.text ?? undefined, fileComments)
    const delivered = yield* writeBack(review, decision.value, text, [])
    if (!delivered) {
      yield* restore(review)
      return ReviewPage.failed()
    }
    return { status: 200, html: ReviewPage.submitted(decision.value) } satisfies Response
  })

  const fail = (status: number, error: string): JsonResponse => ({ status, body: { ok: false, error } })

  /**
   * The approval page's structured submit: `{ t, result, files }`, with `result` a {@link ReviewResult.Submission}
   * and `files` uploaded images as data URLs by name. Everything is checked against the request, written to
   * `feedback/`, then handed to the agent with the referenced images.
   */
  const submitJSON = Effect.fn("ReviewHandler.submitJSON")(function* (reviewID: string, body: unknown) {
    const input = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
    const token = typeof input.t === "string" ? input.t : undefined
    const { review, outcome } = yield* load(reviewID, token)
    if (outcome !== "ok" || !review) {
      const page = ReviewPage.outcome(outcome === "ok" ? "invalid" : outcome)
      return fail(page.status, outcome === "ok" ? "invalid" : outcome)
    }
    if (!deps.root) return fail(503, "review storage is unavailable")
    const uploads = new Map<string, Uint8Array>()
    const mimes = new Map<string, string>()
    const rawFiles = input.files && typeof input.files === "object" ? Object.entries(input.files) : []
    if (rawFiles.length > ReviewResult.MAX_FILES) return fail(413, `at most ${ReviewResult.MAX_FILES} files`)
    for (const [name, value] of rawFiles) {
      const match = typeof value === "string" ? DATA_URL.exec(value) : null
      if (!ReviewResult.fileName(name) || !match) return fail(400, `invalid file ${name.slice(0, 80)}`)
      const bytes = Buffer.from(match[2], "base64")
      if (bytes.byteLength > ReviewResult.MAX_FILE_BYTES) return fail(413, `${name} is too large`)
      uploads.set(name, new Uint8Array(bytes))
      mimes.set(name, match[1])
    }
    const diffFiles = hasDiff(review)
      ? yield* deps.diff(review.sessionID).pipe(
          Effect.map((diffs) => diffs.map((diff) => diff.file)),
          Effect.catchCause(() => Effect.succeed([] as string[])),
        )
      : []
    const now = yield* deps.now
    const result = ReviewResult.check({
      reviewID: review.id,
      now,
      raw: input.result,
      items: items(review),
      uploaded: new Set(uploads.keys()),
      diffFiles,
    })
    if (!result) return fail(400, "invalid result")
    yield* spend(review, result.decision, result.text)
    const root = deps.root
    const written = yield* Effect.tryPromise(() =>
      ReviewAssets.writeFeedback({ root, reviewID: review.id, json: result, files: uploads }),
    ).pipe(Effect.option)
    if (written._tag === "None") {
      yield* restore(review)
      return fail(500, "could not save the feedback")
    }
    const images = ReviewResult.attachments(result).flatMap((name) => {
      const path = written.value.paths.get(name)
      return path ? [{ name, path, mime: mimes.get(name) ?? "image/png" }] : []
    })
    const text = ReviewResult.prompt(result, written.value.feedback)
    const delivered = yield* writeBack(
      review,
      result.decision,
      result.decision === "stop" && ReviewState.followsSession(review) ? undefined : text,
      images,
      written.value.feedback,
    )
    if (!delivered) {
      yield* restore(review)
      return fail(502, "the feedback could not be written back; try again")
    }
    return { status: 200, body: { ok: true, delivered } } satisfies JsonResponse
  })

  /** One snapshotted file of an open review, whole or by byte range. */
  const asset = Effect.fn("ReviewHandler.asset")(function* (input: {
    readonly reviewID: string
    readonly token: string
    readonly item: string
    readonly file: string
    readonly range?: string | null
  }) {
    const { review, outcome } = yield* load(input.reviewID, input.token)
    if (outcome !== "ok" || !review || !deps.root) return { type: "error", status: 404 } satisfies AssetResponse
    const item = items(review).find((candidate) => candidate.id === input.item)
    const stored = item ? ReviewAssets.find(item, input.file) : undefined
    const path = item && stored ? ReviewAssets.filePath(deps.root, item, stored) : undefined
    if (!item || !stored || !path) return { type: "error", status: 404 } satisfies AssetResponse
    const headers: Record<string, string> = { "accept-ranges": "bytes" }
    // Agent pages run scripts, but in an opaque origin: no access to the approval page or its token.
    if (item.kind === "custom") headers["content-security-policy"] = "sandbox allow-scripts allow-forms"
    // HTML is rewritten to inject the host bridge, so its on-disk size and byte ranges no longer apply.
    if (item.kind === "custom" && ReviewCustom.isHtml(stored.mime)) {
      const raw = yield* Effect.tryPromise(() => fs.readFile(path, "utf8")).pipe(Effect.option)
      if (raw._tag === "None") return { type: "error", status: 404 } satisfies AssetResponse
      const bytes = new TextEncoder().encode(ReviewCustom.inject(raw.value))
      return { type: "file", path, mime: stored.mime, size: bytes.length, bytes, status: 200, headers } satisfies AssetResponse
    }
    const range = ReviewAssets.range(input.range, stored.size)
    if (range.type === "unsatisfiable") return { type: "error", status: 416 } satisfies AssetResponse
    if (range.type === "full")
      return { type: "file", path, mime: stored.mime, size: stored.size, status: 200, headers } satisfies AssetResponse
    const bytes = yield* Effect.tryPromise(() => ReviewAssets.readRange(path, range.start, range.end)).pipe(
      Effect.option,
    )
    if (bytes._tag === "None") return { type: "error", status: 404 } satisfies AssetResponse
    return {
      type: "file",
      path,
      mime: stored.mime,
      size: stored.size,
      bytes: bytes.value,
      status: 206,
      headers: {
        ...headers,
        "content-range": `bytes ${range.start}-${range.start + bytes.value.length - 1}/${stored.size}`,
      },
    } satisfies AssetResponse
  })

  /** Same-origin annotator document, only for an open review with a valid token. */
  const annotator = Effect.fn("ReviewHandler.annotator")(function* (reviewID: string, token: string | undefined | null) {
    const { review, outcome } = yield* load(reviewID, token)
    if (outcome !== "ok" || !review || !token) return ReviewPage.outcome(outcome === "ok" ? "invalid" : outcome)
    return { status: 200, html: ReviewAnnotator.html() } satisfies Response
  })

  return { view, submit, submitJSON, asset, annotator }
}
