import { expect, setDefaultTimeout } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { KV } from "@opencode/core/kv"
import { storage } from "@opencode/core/plugin/host"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import fs from "node:fs/promises"
import path from "node:path"
import { ReviewAssets, ReviewBridge, ReviewState, ReviewToken } from "@opencode/review"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Context, DateTime, Effect, Layer } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { serveRoutes } from "./fixture/routes"

setDefaultTimeout(30_000)

// No model runs: wakes are recorded instead, so a prompt written back by the review route is observable.
const wakes: string[] = []
const execution = Layer.effect(
  SessionExecution.Service,
  Effect.succeed(
    SessionExecution.Service.of({
      active: Effect.succeed(new Set()),
      isActive: () => Effect.succeed(false),
      resume: () => Effect.void,
      wake: (sessionID) => Effect.sync(() => void wakes.push(sessionID)),
      interrupt: () => Effect.succeed(false),
      awaitIdle: () => Effect.void,
    }),
  ),
)

it.live("serves the review page and spends the token on submit, outside basic auth", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-review-")))
    const server = yield* serveRoutes(
      {
        password: "secret",
        app: { version: "test-version" },
        database: { path: ":memory:" },
        fs: { filewatcher: false },
        models: { fetch: false },
      },
      [
        SessionExecution.node.replace(
          makeGlobalNode({ service: SessionExecution.Service, layer: execution, deps: [Bus.node] }),
        ),
      ],
    )
    const auth = { authorization: `Basic ${btoa("opencode:secret")}` }
    const fetch = (path: string, init?: RequestInit) =>
      Effect.promise(async () => {
        const response = await server.fetch(`http://opencode.local${path}`, init)
        return { status: response.status, type: response.headers.get("content-type"), text: await response.text() }
      })

    // The protocol API still requires the password; review links do not.
    expect((yield* fetch("/api/session")).status).toBe(401)
    expect((yield* fetch("/api/review/missing?t=x")).status).toBe(404)

    const created = yield* fetch("/api/session", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ location: { directory: tmp.path } }),
    })
    const sessionID = (JSON.parse(created.text).data as { id: string }).id
    const sessions = Context.get(server.context, Session.Service)
    const info = yield* sessions.get(Session.ID.make(sessionID))

    const token = ReviewToken.generate()
    const review: ReviewState.Review = {
      id: "rev1",
      sessionID,
      directory: tmp.path,
      title: "Refactor <parser>",
      summary: "改了解析器",
      tokenHash: ReviewToken.hash(token),
      marker: ReviewState.marker({ busy: info.time.busy ? DateTime.toEpochMillis(info.time.busy) : undefined }),
      createdAt: Date.now(),
      expiresAt: Date.now() + ReviewState.DEFAULT_TTL,
      status: "open",
    }
    const store = storage(Context.get(server.context, KV.Service), ReviewState.PLUGIN_ID)
    yield* store.set(ReviewState.REVIEW_PREFIX + review.id, review)

    const page = yield* fetch(`/api/review/rev1?t=${token}`)
    expect(page.status).toBe(200)
    expect(page.type).toContain("text/html")
    expect(page.text).toContain("改了解析器")
    expect(page.text).toContain("Refactor &lt;parser&gt;")
    expect((yield* fetch(`/api/review/rev1?t=wrong`)).status).toBe(404)

    const submit = () =>
      fetch("/api/review/rev1", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ t: token, decision: "changes", text: "add tests" }).toString(),
      })
    const first = yield* submit()
    expect(first.status).toBe(200)
    expect(first.text).toContain("已提交")
    const inbox = yield* sessions.inbox(Session.ID.make(sessionID))
    expect(inbox).toHaveLength(1)
    expect(inbox[0]).toMatchObject({
      type: "user",
      payload: { metadata: { source: ReviewState.FEEDBACK_SOURCE, reviewID: "rev1", decision: "changes" } },
    })
    expect(JSON.stringify(inbox[0].payload)).toContain("add tests")
    expect(wakes).toContain(sessionID)
    expect(ReviewState.review(yield* store.get(ReviewState.REVIEW_PREFIX + "rev1"))?.status).toBe("submitted")

    const second = yield* submit()
    expect(second.status).toBe(409)
    expect(yield* sessions.inbox(Session.ID.make(sessionID))).toHaveLength(1)
  }),
)

it.live("registers the notifier for the server's lifetime", () =>
  Effect.gen(function* () {
    yield* serveRoutes({ app: { version: "test-version" }, database: { path: ":memory:" }, models: { fetch: false } })
    // No webhook is configured in tests, so publishing only queues the review.
    expect(
      ReviewBridge.publish({ reviewID: "r", token: "t", sessionID: "s", title: "x", summary: "y", directory: "/d" }),
    ).toBe(true)
    // Status reads the server's URLs and webhooks through the bridge.
    expect(ReviewBridge.server()?.urls).toEqual([])
  }),
)

it.live("serves agent review assets by range and takes the structured submit with images", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-review-")))
    const server = yield* serveRoutes(
      {
        password: "secret",
        app: { version: "test-version" },
        database: { path: ":memory:" },
        fs: { filewatcher: false },
        models: { fetch: false },
      },
      [
        SessionExecution.node.replace(
          makeGlobalNode({ service: SessionExecution.Service, layer: execution, deps: [Bus.node] }),
        ),
      ],
    )
    const auth = { authorization: `Basic ${btoa("opencode:secret")}` }
    const created = yield* Effect.promise(async () => {
      const response = await server.fetch("http://opencode.local/api/session", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ location: { directory: tmp.path } }),
      })
      return (await response.json()) as { data: { id: string } }
    })
    const sessionID = created.data.id
    const sessions = Context.get(server.context, Session.Service)

    // The plugin learns where to put snapshots from the server, through the bridge.
    const root = ReviewBridge.server()?.root
    expect(root).toBeString()
    yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "clip.mp4"), Buffer.from("0123456789")))
    yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "far.png"), "PNGDATA"))
    const id = "agent" + Math.random().toString(36).slice(2, 8)
    const items = yield* ReviewAssets.snapshot({
      root: root!,
      directory: tmp.path,
      bundle: id,
      items: [
        { id: "shots", kind: "image", title: "Renders", assets: [{ id: "far", path: "far.png" }] },
        { id: "clip", kind: "video", title: "Clip", assets: [{ id: "c", path: "clip.mp4" }] },
      ],
    })
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => fs.rm(path.join(root!, id), { recursive: true, force: true })),
    )
    const token = ReviewToken.generate()
    const review: ReviewState.Review = {
      id,
      sessionID,
      directory: tmp.path,
      title: "Lighting",
      summary: "看看灯光",
      tokenHash: ReviewToken.hash(token),
      marker: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + ReviewState.DEFAULT_TTL,
      status: "open",
      origin: "agent",
      request: { items, wait: { mode: "async" } },
    }
    const store = storage(Context.get(server.context, KV.Service), ReviewState.PLUGIN_ID)
    yield* store.set(ReviewState.REVIEW_PREFIX + id, review)

    const get = (file: string, headers?: Record<string, string>) =>
      Effect.promise(async () => {
        const response = await server.fetch(`http://opencode.local/api/review/${id}/a/${token}/${file}`, { headers })
        return { status: response.status, headers: response.headers, text: await response.text() }
      })
    const whole = yield* get("clip/c.mp4")
    expect(whole.status).toBe(200)
    expect(whole.text).toBe("0123456789")
    expect(whole.headers.get("content-type")).toBe("video/mp4")
    expect(whole.headers.get("accept-ranges")).toBe("bytes")
    const part = yield* get("clip/c.mp4", { range: "bytes=3-5" })
    expect(part.status).toBe(206)
    expect(part.text).toBe("345")
    expect(part.headers.get("content-range")).toBe("bytes 3-5/10")
    expect((yield* get("clip/c.mp4", { range: "bytes=50-60" })).status).toBe(416)
    expect((yield* get("clip/..%2Fshots%2Ffar.png")).status).toBe(404)

    const submit = (body: unknown) =>
      Effect.promise(async () => {
        const response = await server.fetch(`http://opencode.local/api/review/${id}/submit`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
        return { status: response.status, body: (await response.json()) as { ok: boolean; delivered?: string } }
      })
    const result = {
      decision: "changes",
      items: [
        {
          id: "shots",
          assets: [
            {
              asset: "far",
              verdict: "fail",
              annotations: [{ n: 1, shape: "point", rect: { x1: 3, y1: 4, x2: 4, y2: 5 }, text: "太暗" }],
              files: ["shots-far.png"],
            },
          ],
        },
      ],
    }
    const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="
    const png = "data:image/png;base64," + pixel
    const answer = yield* submit({ t: token, result, files: { "shots-far.png": png } })
    expect(answer).toEqual({ status: 200, body: { ok: true, delivered: "message" } })
    const inbox = yield* sessions.inbox(Session.ID.make(sessionID))
    expect(inbox).toHaveLength(1)
    const payload = JSON.stringify(inbox[0].payload)
    expect(payload).toContain("太暗")
    expect(payload).toContain("shots-far.png")
    // The annotated image travels as a file part the model can see, not just a path in the text.
    expect((inbox[0].payload as { files?: { mime: string; name: string }[] }).files).toMatchObject([
      { mime: "image/png", name: "shots-far.png" },
    ])
    const saved = yield* Effect.promise(() => fs.readFile(path.join(root!, id, "feedback", "shots-far.png")))
    expect(saved.toString("base64")).toBe(pixel)
    expect((yield* submit({ t: token, result })).status).toBe(409)
  }),
)
