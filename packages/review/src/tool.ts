export * as ReviewTool from "./tool.js"

import fs from "node:fs/promises"
import { Tool } from "@opencode/schema/tool"
import { Clock, Effect } from "effect"
import type { ReviewController } from "./controller.js"
import { ReviewRequest } from "./request.js"
import { ReviewToken } from "./token.js"
import { ReviewWaiters } from "./waiters.js"

export const NAME = "review_request"

export const DESCRIPTION = `Ask the user to review your work on their phone or another browser, mid-task. Use it when a person has to look: game render screenshots, UI, animation or video, code changes, or an interactive page you built.

Items (each answered on its own, all submitted at once):
- image: assets[] of 1-20 images (png, jpg, webp, gif, avif); optional compare image per asset.
- video: assets[] of 1-20 videos. Prefer H.264 MP4 (faststart) so every phone plays it; set fps for frame stepping. The user can mark a frame and draw on it.
- diff: the session's code changes, judged per file; diff.files limits it to some files.
- custom: an HTML page you wrote (custom.entry plus custom.files it loads), shown in a sandbox; use it for anything interactive.
Per item, feedback picks what the user gives: annotate (points/boxes per asset, line comments for diff), verdict (pass/fail per asset), checks (named pass/fail checkpoints); required forces a verdict.
Paths are relative to the working directory and are copied when you call, so later edits do not change what is reviewed. Limits: 50 items, 20 assets per item, image 30 MB, video 300 MB, 1 GB per review.

Waiting is your decision:
- wait.mode "async" (default): returns at once. Keep working; the feedback arrives later as a user message starting with "[Remote review]".
- wait.mode "block": this call returns the feedback (text plus annotated images). Add timeoutMs to stop waiting, and onTimeout.plan to tell the user what you will do then; onTimeout.link "keep" lets late feedback still arrive as a message, "close" ends the link.
- send "with_next_idle": do not notify now; the items join the next idle or /review-remote now review.

Coordinates in feedback are pixels of the original image or video frame (origin top left); video annotations carry the frame time and index. Remote review must be on (/review-remote on) and reachable from the phone.`

export interface Deps {
  readonly request: (
    sessionID: string,
    input: ReviewRequest.Input,
    id: string,
  ) => Effect.Effect<ReviewController.Requested, Error>
  readonly close: (reviewID: string) => Effect.Effect<void>
  readonly id?: () => string
}

/** Annotated images returned to a blocked call are capped so one result cannot flood the context. */
export const MAX_RESULT_IMAGE_BYTES = 8 * 1024 * 1024

const minutes = (ms: number) => `${Math.round(ms / 60_000)} min`

const images = (delivery: ReviewWaiters.Delivery) =>
  Effect.promise(async () => {
    const content: Tool.Content[] = []
    let total = 0
    for (const image of delivery.images) {
      const bytes = await fs.readFile(image.path).catch(() => undefined)
      if (!bytes || total + bytes.byteLength > MAX_RESULT_IMAGE_BYTES) continue
      total += bytes.byteLength
      content.push({
        type: "file",
        uri: `data:${image.mime};base64,${bytes.toString("base64")}`,
        mime: image.mime,
        name: image.name,
      })
    }
    return content
  })

export function make(deps: Deps): Tool.Info<typeof ReviewRequest.Input> {
  return {
    name: NAME,
    description: DESCRIPTION,
    input: ReviewRequest.Input,
    options: { codemode: false },
    execute: (input, context) =>
      Effect.gen(function* () {
        const id = deps.id?.() ?? ReviewToken.id()
        const blocking = input.wait?.mode === "block" && input.send !== "with_next_idle"
        // Registered before the link goes out. A delivery that loses the race with a timeout is kept, not dropped.
        let received: ReviewWaiters.Delivery | undefined
        let settled = false
        let wake: (() => void) | undefined
        const arrived = new Promise<void>((resolve) => (wake = resolve))
        const unregister = blocking
          ? ReviewWaiters.register(id, (delivery) => {
              if (settled) return false
              received = delivery
              wake?.()
              return true
            })
          : () => {}
        const requested = yield* deps.request(context.sessionID, input, id).pipe(
          Effect.mapError((error) => new Tool.Error({ message: error.message })),
          Effect.tapError(() => Effect.sync(unregister)),
        )
        if (requested.type === "queued")
          return {
            content: `Queued: ${requested.count} item(s) will join the next idle or /review-remote now review. No notification was sent.`,
            metadata: { state: "queued" },
          }
        if (!blocking)
          return {
            content: `Review ${id} was sent to the user. Do not wait for it; continue with your work. When the user submits, the feedback arrives as a user message starting with "[Remote review]".`,
            metadata: { reviewID: id, state: "sent" },
          }

        yield* context.progress({ reviewID: id, state: "waiting" })
        const now = yield* Clock.currentTimeMillis
        const limit = input.wait?.timeoutMs ?? Math.max(0, requested.review.expiresAt - now)
        const stop = Effect.sync(() => {
          settled = true
          unregister()
        })
        const outcome = yield* Effect.promise(() => arrived).pipe(
          Effect.as("submitted" as const),
          Effect.raceFirst(Effect.sleep(limit).pipe(Effect.as("timeout" as const))),
          Effect.raceFirst(context.cancel ? context.cancel.pipe(Effect.as("cancelled" as const)) : Effect.never),
          Effect.ensuring(stop),
        )
        const delivery = received
        if (delivery) {
          const files = yield* images(delivery)
          return {
            content: [{ type: "text" as const, text: delivery.text }, ...files],
            metadata: { reviewID: id, state: "submitted", decision: delivery.decision, feedback: delivery.feedback },
          }
        }
        if (outcome === "cancelled")
          return yield* new Tool.Error({
            message: `Stopped waiting for review ${id}. The link stays open; feedback submitted later arrives as a user message.`,
          })
        const close = input.wait?.onTimeout?.link === "close"
        if (close) yield* deps.close(id)
        const plan = input.wait?.onTimeout?.plan.trim()
        return {
          content: [
            `No feedback on review ${id} after ${minutes(limit)}.`,
            plan ? `You told the user you would: ${plan}` : "Decide how to proceed without it.",
            close
              ? "The link is closed."
              : 'The link stays open; feedback submitted later arrives as a user message starting with "[Remote review]".',
          ].join(" "),
          metadata: { reviewID: id, state: "timeout", closed: close },
        }
      }),
  }
}
