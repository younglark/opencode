import { afterAll, describe, expect, test } from "bun:test"
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
    expect(page.html).toContain('data-decision="changes"')
    expect(page.html).toContain(h.token)
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
    expect(h.storage.map.get(ReviewState.OPEN_PREFIX + "s1")).toEqual(["r1"])
  })
})

describe("agent reviews", async () => {
  const fs = await import("node:fs/promises")
  const os = await import("node:os")
  const path = await import("node:path")
  const { ReviewAssets } = await import("../src/assets.js")
  const { ReviewWaiters } = await import("../src/waiters.js")
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "review-handler-"))
  const work = path.join(temp, "work")
  const root = path.join(temp, "root")
  afterAll(() => fs.rm(temp, { recursive: true, force: true }))
  await fs.mkdir(work, { recursive: true })
  await fs.writeFile(path.join(work, "far.png"), "PNGDATA")
  await fs.writeFile(path.join(work, "clip.mp4"), Buffer.from("0123456789"))
  const PNG = "data:image/png;base64," + Buffer.from("annotated").toString("base64")

  async function agentSetup(options: { wait?: boolean; promptFails?: boolean } = {}) {
    const storage = memoryStorage()
    const clock = { now: 5_000 }
    const prompts: { sessionID: string; text: string; files?: ReadonlyArray<{ name: string; path: string }> }[] = []
    const deliveries: unknown[] = []
    let diffCalls = 0
    const token = ReviewToken.generate()
    const id = "a" + Math.random().toString(36).slice(2, 8)
    const items = await run(
      ReviewAssets.snapshot({
        root,
        directory: work,
        bundle: id,
        items: [
          { id: "shots", kind: "image", title: "Renders", assets: [{ id: "far", path: "far.png" }] },
          { id: "clip", kind: "video", title: "Clip", assets: [{ id: "c", path: "clip.mp4", fps: 30 }] },
        ],
      }),
    )
    const review: ReviewState.Review = {
      id,
      sessionID: "s1",
      directory: work,
      title: "Lighting",
      summary: "看看灯光",
      tokenHash: ReviewToken.hash(token),
      marker: 100,
      createdAt: 1_000,
      expiresAt: 1_000 + ReviewState.DEFAULT_TTL,
      status: "open",
      origin: "agent",
      request: { items, wait: { mode: "block" } },
    }
    storage.map.set(ReviewState.REVIEW_PREFIX + id, review)
    storage.map.set(ReviewState.OPEN_PREFIX + "s1", [id])
    const unregister = options.wait
      ? ReviewWaiters.register(id, (delivery) => (deliveries.push(delivery), true))
      : () => {}
    const handler = ReviewHandler.make({
      storage,
      root,
      now: Effect.sync(() => clock.now),
      // Running: an agent review stays usable while the session works.
      session: () => Effect.succeed({ busy: 4_000, idle: 100 }),
      diff: () => Effect.sync(() => (diffCalls++, [])),
      prompt: (input) => (options.promptFails ? Effect.fail("busy") : Effect.sync(() => void prompts.push(input))),
    })
    const stored = () => ReviewState.review(storage.map.get(ReviewState.REVIEW_PREFIX + id))!
    return { handler, token, id, prompts, deliveries, stored, storage, unregister, diffCalls: () => diffCalls }
  }

  const result = {
    decision: "changes",
    items: [
      {
        id: "shots",
        assets: [
          {
            asset: "far",
            verdict: "fail",
            annotations: [{ n: 1, shape: "rect", rect: { x1: 1, y1: 2, x2: 30, y2: 40 }, text: "阴影反了" }],
            files: ["shots-far.png"],
          },
        ],
      },
    ],
  }

  test("the page shows the wait mode and every asset, without reading the diff", async () => {
    const h = await agentSetup()
    const page = await run(h.handler.view(h.id, h.token))
    expect(page.status).toBe(200)
    expect(page.html).toContain("正在等你的反馈")
    expect(page.html).toContain(`/api/review/${h.id}/a/${encodeURIComponent(h.token)}/shots/far.png`)
    expect(page.html).toContain("<video")
    expect(h.diffCalls()).toBe(0)
  })

  test("serves snapshot files whole or by range, only with the token and only recorded files", async () => {
    const h = await agentSetup()
    const whole = await run(h.handler.asset({ reviewID: h.id, token: h.token, item: "shots", file: "far.png" }))
    expect(whole).toMatchObject({ type: "file", status: 200, mime: "image/png", size: 7 })
    const part = await run(
      h.handler.asset({ reviewID: h.id, token: h.token, item: "clip", file: "c.mp4", range: "bytes=2-4" }),
    )
    expect(part).toMatchObject({ type: "file", status: 206, headers: { "content-range": "bytes 2-4/10" } })
    expect(part.type === "file" && Buffer.from(part.bytes!).toString()).toBe("234")
    expect(await run(h.handler.asset({ reviewID: h.id, token: "x", item: "shots", file: "far.png" }))).toEqual({
      type: "error",
      status: 404,
    })
    expect(
      await run(h.handler.asset({ reviewID: h.id, token: h.token, item: "shots", file: "../clip/c.mp4" })),
    ).toEqual({
      type: "error",
      status: 404,
    })
  })

  test("a structured submit is saved and written back with the annotated image", async () => {
    const h = await agentSetup()
    const answer = await run(h.handler.submitJSON(h.id, { t: h.token, result, files: { "shots-far.png": PNG } }))
    expect(answer).toEqual({ status: 200, body: { ok: true, delivered: "message" } })
    expect(h.stored().status).toBe("submitted")
    expect(h.storage.map.has(ReviewState.OPEN_PREFIX + "s1")).toBe(false)
    expect(h.prompts[0].text).toContain("① box (1,2)-(30,40): 阴影反了")
    expect(h.prompts[0].text).toContain("feedback.json")
    expect(h.prompts[0].files?.map((file) => file.name)).toEqual(["shots-far.png"])
    expect(await fs.readFile(h.prompts[0].files![0].path, "utf8")).toBe("annotated")
    const saved = JSON.parse(await fs.readFile(path.join(root, h.id, "feedback", "feedback.json"), "utf8"))
    expect(saved.items[0].assets[0].verdict).toBe("fail")
    const again = await run(h.handler.submitJSON(h.id, { t: h.token, result }))
    expect(again.status).toBe(409)
  })

  test("a blocked review_request call gets the feedback instead of the session", async () => {
    const h = await agentSetup({ wait: true })
    const answer = await run(h.handler.submitJSON(h.id, { t: h.token, result, files: { "shots-far.png": PNG } }))
    expect(answer.body.delivered).toBe("tool")
    expect(h.prompts).toHaveLength(0)
    expect(h.deliveries[0]).toMatchObject({ reviewID: h.id, decision: "changes", images: [{ name: "shots-far.png" }] })
    h.unregister()
  })

  test("stop still reaches an agent; bad input and failed writes keep the link", async () => {
    const stop = await agentSetup()
    await run(stop.handler.submitJSON(stop.id, { t: stop.token, result: { decision: "stop" } }))
    expect(stop.prompts[0].text).toContain("Please stop here")
    const h = await agentSetup({ promptFails: true })
    expect((await run(h.handler.submitJSON(h.id, { t: h.token, result: { decision: "maybe" } }))).status).toBe(400)
    expect((await run(h.handler.submitJSON(h.id, { t: h.token, result, files: { "../x.png": PNG } }))).status).toBe(400)
    const failed = await run(h.handler.submitJSON(h.id, { t: h.token, result }))
    expect(failed.status).toBe(502)
    expect(h.stored().status).toBe("open")
    expect(h.storage.map.get(ReviewState.OPEN_PREFIX + "s1")).toEqual([h.id])
  })
})
