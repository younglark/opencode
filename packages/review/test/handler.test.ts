import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ReviewDecide } from "../src/decide.js"
import { ReviewHandler } from "../src/handler.js"
import { ReviewState } from "../src/state.js"
import { ReviewToken } from "../src/token.js"
import { memoryStorage, run } from "./fixture.js"

function setup(options: { promptFails?: boolean; context?: boolean } = {}) {
  const storage = memoryStorage()
  const clock = { now: 5_000 }
  const sessions = new Map<string, ReviewDecide.SessionView>([["s1", { busy: 100, idle: 200 }]])
  const prompts: { sessionID: string; text: string; metadata: Record<string, unknown> }[] = []
  const token = ReviewToken.generate()
  const review: ReviewState.Review = {
    id: "r1",
    sessionID: "s1",
    directory: "/repo",
    title: "Fix <bug>",
    summary: "改了 a.ts",
    tokenHash: ReviewToken.hash(token),
    marker: 100,
    createdAt: 1_000,
    expiresAt: 1_000 + ReviewState.DEFAULT_TTL,
    status: "open",
  }
  storage.map.set(ReviewState.REVIEW_PREFIX + "r1", review)
  storage.map.set(ReviewState.OPEN_PREFIX + "s1", "r1")
  const handler = ReviewHandler.make({
    storage,
    now: Effect.sync(() => clock.now),
    session: (id) => Effect.sync(() => sessions.get(id)),
    diff: () =>
      Effect.succeed([
        { file: "a.ts", patch: "@@ -1 +1 @@\n-old\n+<new>", additions: 1, deletions: 1, status: "modified" },
      ]),
    prompt: (input) => (options.promptFails ? Effect.fail("busy") : Effect.sync(() => void prompts.push(input))),
    context: options.context
      ? () =>
          Effect.succeed({
            title: "Fix <bug>",
            request: "请修复登录",
            recent: [{ role: "user" as const, text: "请修复登录" }],
          })
      : undefined,
  })
  const stored = () => ReviewState.review(storage.map.get(ReviewState.REVIEW_PREFIX + "r1"))!
  return { handler, token, clock, sessions, prompts, stored, storage }
}

describe("approval page", () => {
  test("renders summary, escaped diff and the form for a valid link", async () => {
    const h = setup()
    const page = await run(h.handler.view("r1", h.token))
    expect(page.status).toBe(200)
    expect(page.html).toContain("改了 a.ts")
    expect(page.html).toContain("Fix &lt;bug&gt;")
    expect(page.html).toContain("+&lt;new&gt;")
    expect(page.html).not.toContain("<new>")
    expect(page.html).toContain('name="decision" value="changes"')
    expect(page.html).toContain(`value="${h.token}"`)
  })

  test("renders task context when the session can supply it", async () => {
    const h = setup({ context: true })
    const page = await run(h.handler.view("r1", h.token))
    expect(page.status).toBe(200)
    expect(page.html).toContain("请修复登录")
    expect(page.html).toContain("任务背景")
  })

  test("refuses a wrong token without revealing the review", async () => {
    const h = setup()
    const page = await run(h.handler.view("r1", "wrong"))
    expect(page.status).toBe(404)
    expect(page.html).not.toContain("改了 a.ts")
  })
})

describe("submit", () => {
  test("writes feedback back once with the marker, then the token is spent", async () => {
    const h = setup()
    const first = await run(h.handler.submit("r1", { t: h.token, decision: "changes", text: "rename foo" }))
    expect(first.status).toBe(200)
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0].sessionID).toBe("s1")
    expect(h.prompts[0].text).toContain("rename foo")
    expect(h.prompts[0].metadata).toEqual({ source: ReviewState.FEEDBACK_SOURCE, reviewID: "r1", decision: "changes" })
    expect(h.stored().status).toBe("submitted")
    expect(h.storage.map.has(ReviewState.OPEN_PREFIX + "s1")).toBe(false)
    const again = await run(h.handler.submit("r1", { t: h.token, decision: "continue" }))
    expect(again.status).toBe(409)
    expect(h.prompts).toHaveLength(1)
    expect((await run(h.handler.view("r1", h.token))).html).toContain("已经提交过")
  })

  test("writes overall text and per-file comments back together", async () => {
    const h = setup()
    const page = await run(
      h.handler.submit("r1", {
        t: h.token,
        decision: "changes",
        text: "rename foo",
        comments: [
          { file: "a.ts", text: "unused" },
          { file: "b.ts", text: "" },
        ],
      }),
    )
    expect(page.status).toBe(200)
    expect(page.html).toContain("已把修改意见发给 agent")
    expect(h.prompts).toHaveLength(1)
    expect(h.prompts[0].text).toContain("rename foo")
    expect(h.prompts[0].text).toContain("- a.ts:")
    expect(h.prompts[0].text).toContain("  unused")
    expect(h.prompts[0].text).not.toContain("b.ts")
  })

  test("rejects when the session progressed on the desktop since the review started", async () => {
    const h = setup()
    h.sessions.set("s1", { busy: 300, idle: 400 })
    const page = await run(h.handler.submit("r1", { t: h.token, decision: "continue" }))
    expect(page.status).toBe(409)
    expect(page.html).toContain("已在电脑端继续")
    expect(h.prompts).toHaveLength(0)
    expect(h.stored().status).toBe("open")
  })

  test("rejects an expired link and an unknown decision", async () => {
    const h = setup()
    expect((await run(h.handler.submit("r1", { t: h.token, decision: "nope" }))).status).toBe(400)
    h.clock.now = h.stored().expiresAt
    expect((await run(h.handler.submit("r1", { t: h.token, decision: "continue" }))).status).toBe(410)
  })

  test("stop records the decision without prompting", async () => {
    const h = setup()
    const page = await run(h.handler.submit("r1", { t: h.token, decision: "stop" }))
    expect(page.status).toBe(200)
    expect(h.prompts).toHaveLength(0)
    expect(h.stored().decision).toBe("stop")
  })

  test("gives the link back when writing feedback fails", async () => {
    const h = setup({ promptFails: true })
    const page = await run(h.handler.submit("r1", { t: h.token, decision: "continue" }))
    expect(page.status).toBe(502)
    expect(h.stored().status).toBe("open")
    expect(h.storage.map.get(ReviewState.OPEN_PREFIX + "s1")).toBe("r1")
  })
})
