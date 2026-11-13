import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import type { Tool } from "@opencode/schema/tool"
import type { ReviewController } from "../src/controller.js"
import type { ReviewRequest } from "../src/request.js"
import { ReviewState } from "../src/state.js"
import { ReviewTool } from "../src/tool.js"
import { ReviewWaiters } from "../src/waiters.js"

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "review-tool-"))
afterAll(() => fs.rm(temp, { recursive: true, force: true }))
const image = path.join(temp, "shots-far.png")
await fs.writeFile(image, "annotated")

let counter = 0
function harness(options: { queued?: boolean; fails?: string; expiresIn?: number } = {}) {
  const calls: { sessionID: string; id: string; input: ReviewRequest.Input }[] = []
  const closed: string[] = []
  const progress: unknown[] = []
  const id = `t${++counter}`
  const tool = ReviewTool.make({
    id: () => id,
    close: (reviewID) => Effect.sync(() => void closed.push(reviewID)),
    request: (sessionID, input, reviewID) =>
      Effect.suspend(() => {
        calls.push({ sessionID, id: reviewID, input })
        if (options.fails) return Effect.fail(new Error(options.fails))
        if (options.queued) return Effect.succeed<ReviewController.Requested>({ type: "queued", count: 2 })
        const review = { id: reviewID, expiresAt: Date.now() + (options.expiresIn ?? 60_000) } as ReviewState.Review
        return Effect.succeed<ReviewController.Requested>({ type: "sent", review })
      }),
  })
  const context = (cancel?: Effect.Effect<void>) =>
    ({
      sessionID: "s1",
      agent: "build",
      messageID: "m1",
      id: "call1",
      progress: (update: Tool.Metadata) => Effect.sync(() => void progress.push(update)),
      ...(cancel ? { cancel } : {}),
    }) as unknown as Tool.Context
  return { tool, calls, closed, progress, id, context }
}

const input = (wait?: ReviewRequest.Wait, send?: "now" | "with_next_idle"): ReviewRequest.Input => ({
  title: "Lighting",
  items: [{ id: "shots", kind: "image", title: "Renders", assets: [{ path: "far.png" }] }],
  ...(wait ? { wait } : {}),
  ...(send ? { send } : {}),
})

const text = (result: { content?: string | ReadonlyArray<Tool.Content> }) =>
  typeof result.content === "string"
    ? result.content
    : (result.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("")

describe("review_request", () => {
  test("is a direct tool named review_request with the request schema", () => {
    const h = harness()
    expect(h.tool.name).toBe("review_request")
    expect(h.tool.options).toEqual({ codemode: false })
    expect(h.tool.description).toContain("with_next_idle")
  })

  test("async returns at once and says feedback arrives as a message", async () => {
    const h = harness()
    const result = await Effect.runPromise(h.tool.execute(input(), h.context()))
    expect(text(result)).toContain(`Review ${h.id} was sent`)
    expect(result.metadata).toEqual({ reviewID: h.id, state: "sent" })
    expect(ReviewWaiters.waiting(h.id)).toBe(false)
    expect(h.calls[0]).toMatchObject({ sessionID: "s1", id: h.id })
  })

  test("queued items report the count", async () => {
    const h = harness({ queued: true })
    const result = await Effect.runPromise(h.tool.execute(input(undefined, "with_next_idle"), h.context()))
    expect(text(result)).toContain("2 item(s) will join")
  })

  test("block waits for the submission and returns text plus images", async () => {
    const h = harness()
    const running = Effect.runPromise(h.tool.execute(input({ mode: "block" }), h.context()))
    await Bun.sleep(10)
    expect(h.progress).toEqual([{ reviewID: h.id, state: "waiting" }])
    expect(
      ReviewWaiters.deliver({
        reviewID: h.id,
        decision: "changes",
        text: "[Remote review] fix the shadow",
        feedback: "/x/feedback.json",
        images: [{ name: "shots-far.png", path: image, mime: "image/png" }],
      }),
    ).toBe(true)
    const result = await running
    expect(text(result)).toContain("fix the shadow")
    const parts = result.content as ReadonlyArray<Tool.Content>
    expect(parts[1]).toMatchObject({ type: "file", mime: "image/png", name: "shots-far.png" })
    expect(parts[1].type === "file" && parts[1].uri).toBe(
      "data:image/png;base64," + Buffer.from("annotated").toString("base64"),
    )
    expect(result.metadata).toMatchObject({ state: "submitted", decision: "changes" })
    expect(ReviewWaiters.waiting(h.id)).toBe(false)
  })

  test("a timeout reports the plan, closes the link when asked, and later feedback goes to the session", async () => {
    const h = harness()
    const result = await Effect.runPromise(
      h.tool.execute(
        input({ mode: "block", timeoutMs: 20, onTimeout: { plan: "按方案 A 继续", link: "close" } }),
        h.context(),
      ),
    )
    expect(text(result)).toContain("按方案 A 继续")
    expect(text(result)).toContain("The link is closed")
    expect(h.closed).toEqual([h.id])
    expect(ReviewWaiters.deliver({ reviewID: h.id, decision: "continue", text: "late", images: [] })).toBe(false)
  })

  test("keep leaves the link open; a user stop fails the call but keeps the link", async () => {
    const keep = harness()
    const kept = await Effect.runPromise(
      keep.tool.execute(
        input({ mode: "block", timeoutMs: 20, onTimeout: { plan: "继续", link: "keep" } }),
        keep.context(),
      ),
    )
    expect(text(kept)).toContain("The link stays open")
    expect(keep.closed).toEqual([])
    const stop = harness()
    const error = await Effect.runPromise(
      Effect.flip(stop.tool.execute(input({ mode: "block" }), stop.context(Effect.sleep(10)))),
    )
    expect(error.message).toContain("Stopped waiting")
    expect(ReviewWaiters.waiting(stop.id)).toBe(false)
  })

  test("request failures become tool errors and leave no waiter", async () => {
    const h = harness({ fails: "Remote review is off" })
    const error = await Effect.runPromise(Effect.flip(h.tool.execute(input({ mode: "block" }), h.context())))
    expect(error.message).toBe("Remote review is off")
    expect(ReviewWaiters.waiting(h.id)).toBe(false)
  })
})
