import { expect, setDefaultTimeout } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { KV } from "@opencode/core/kv"
import { storage } from "@opencode/core/plugin/host"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { ReviewBridge, ReviewState, ReviewToken } from "@opencode/review"
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
  }),
)
