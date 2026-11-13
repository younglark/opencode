import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { ReviewBridge } from "../src/bridge.js"
import { ReviewController } from "../src/controller.js"
import { ReviewState } from "../src/state.js"
import type { ReviewStatus } from "../src/status.js"
import { ReviewToken } from "../src/token.js"
import { memoryStorage, run } from "./fixture.js"

function harness(
  options: { directory?: string; summary?: () => Effect.Effect<string>; server?: ReviewStatus.Server } = {},
) {
  const storage = memoryStorage()
  const clock = { now: 1_000_000 }
  const sessions = new Map<string, ReviewController.SessionView>()
  const scheduled = new Map<string, { delayMs: number; effect: Effect.Effect<void> }>()
  const published: ReviewBridge.Ready[] = []
  const controller = ReviewController.make({
    directory: options.directory ?? "/repo",
    storage,
    now: Effect.sync(() => clock.now),
    session: (id) => Effect.sync(() => sessions.get(id)),
    summarize: options.summary ?? (() => Effect.succeed("did things")),
    publish: (review) => Effect.sync(() => (published.push(review), true)),
    schedule: (id, delayMs, effect) => Effect.sync(() => void scheduled.set(id, { delayMs, effect })),
    cancel: (id) => Effect.sync(() => void scheduled.delete(id)),
    server: () => options.server,
  })
  const idleSession = (id: string, busy = 500, extra: Partial<ReviewController.SessionView> = {}) =>
    sessions.set(id, { id, title: `title ${id}`, directory: "/repo", busy, idle: busy + 100, ...extra })
  const enable = (durationMs = 10 * 60_000) =>
    storage.set(ReviewState.SETTINGS_KEY, { enabled: true, durationMs }).pipe(run)
  const fireScheduled = async (id: string) => {
    const entry = scheduled.get(id)
    scheduled.delete(id)
    if (entry) await run(entry.effect)
  }
  return { storage, clock, sessions, scheduled, published, controller, idleSession, enable, fireScheduled }
}

describe("settings and command", () => {
  test("defaults to off with 10 minutes; on reuses the last duration", async () => {
    const h = harness()
    expect(await run(h.controller.settings)).toEqual({ enabled: false, durationMs: 600_000 })
    await run(h.controller.command("s1", "15m"))
    expect(await run(h.controller.settings)).toEqual({ enabled: true, durationMs: 900_000 })
    await run(h.controller.command("s1", "off"))
    expect((await run(h.controller.settings)).enabled).toBe(false)
    await run(h.controller.command("s1", "on"))
    expect(await run(h.controller.settings)).toEqual({ enabled: true, durationMs: 900_000 })
    const status = await run(h.controller.command("s1", ""))
    expect(status).toContain("Remote review on · idle 15m")
    expect(await Effect.runPromise(Effect.flip(h.controller.command("s1", "xyz")))).toBeInstanceOf(Error)
  })
})

describe("timer", () => {
  test("does nothing while off, and ignores child sessions", async () => {
    const h = harness()
    h.idleSession("s1")
    await run(h.controller.finished("s1"))
    expect(h.scheduled.size).toBe(0)
    await h.enable()
    h.idleSession("child", 500, { parentID: "s1" })
    await run(h.controller.finished("child"))
    expect(h.scheduled.size).toBe(0)
  })

  test("stores an absolute deadline and dedupes repeated triggers", async () => {
    const h = harness()
    await h.enable()
    h.idleSession("s1")
    await run(h.controller.finished("s1"))
    expect(h.scheduled.get("s1")?.delayMs).toBe(600_000)
    expect(h.storage.map.get(ReviewState.TIMER_PREFIX + "s1")).toEqual({
      sessionID: "s1",
      deadline: 1_600_000,
      marker: 500,
      armedAt: 1_000_000,
    })
    // The same execution end reported again later must not push the deadline out.
    h.clock.now += 60_000
    h.scheduled.clear()
    await run(h.controller.finished("s1"))
    expect(h.scheduled.size).toBe(0)
    expect(ReviewState.timer(h.storage.map.get(ReviewState.TIMER_PREFIX + "s1"))?.deadline).toBe(1_600_000)
  })

  test("firing opens one review, publishes the token and stores only its hash", async () => {
    const h = harness()
    await h.enable()
    h.idleSession("s1")
    await run(h.controller.finished("s1"))
    h.clock.now += 600_000
    await h.fireScheduled("s1")
    expect(h.published).toHaveLength(1)
    const ready = h.published[0]
    const review = ReviewState.review(h.storage.map.get(ReviewState.REVIEW_PREFIX + ready.reviewID))!
    expect(review.status).toBe("open")
    expect(review.summary).toBe("did things")
    expect(review.marker).toBe(500)
    expect(review.expiresAt - review.createdAt).toBe(ReviewState.DEFAULT_TTL)
    expect(review.tokenHash).toBe(ReviewToken.hash(ready.token))
    expect(JSON.stringify([...h.storage.map.values()])).not.toContain(ready.token)
    expect(h.storage.map.has(ReviewState.TIMER_PREFIX + "s1")).toBe(false)
    // The same execution cannot open a second review.
    await run(h.controller.finished("s1"))
    expect(h.scheduled.size).toBe(0)
  })

  test("falls back to the title when the summary fails", async () => {
    const h = harness({ summary: () => Effect.die("model down") })
    await h.enable()
    h.idleSession("s1")
    await run(h.controller.finished("s1"))
    await h.fireScheduled("s1")
    expect(h.published[0].summary).toBe("title s1")
  })

  test("does not fire if the session moved on or the mode was turned off", async () => {
    const h = harness()
    await h.enable()
    h.idleSession("s1")
    await run(h.controller.finished("s1"))
    h.idleSession("s1", 900)
    await h.fireScheduled("s1")
    expect(h.published).toHaveLength(0)

    h.idleSession("s2")
    await run(h.controller.finished("s2"))
    const pending = h.scheduled.get("s2")!
    await run(h.controller.command("s2", "off"))
    expect(h.scheduled.has("s2")).toBe(false)
    await run(pending.effect)
    expect(h.published).toHaveLength(0)
  })

  test("a new execution or typed input cancels the timer; typed input supersedes an open review", async () => {
    const h = harness()
    await h.enable()
    h.idleSession("s1")
    await run(h.controller.finished("s1"))
    await run(h.controller.started("s1"))
    expect(h.scheduled.has("s1")).toBe(false)
    expect(h.storage.map.has(ReviewState.TIMER_PREFIX + "s1")).toBe(false)

    await run(h.controller.finished("s1"))
    await h.fireScheduled("s1")
    const reviewID = h.published[0].reviewID
    await run(h.controller.humanInput("s1"))
    expect(ReviewState.review(h.storage.map.get(ReviewState.REVIEW_PREFIX + reviewID))?.status).toBe("superseded")
    expect(h.storage.map.has(ReviewState.OPEN_PREFIX + "s1")).toBe(false)
  })

  test("restore re-arms this Location's timers from their deadlines", async () => {
    const h = harness()
    h.idleSession("future")
    h.idleSession("overdue")
    h.idleSession("elsewhere", 500, { directory: "/other" })
    const timer = (sessionID: string, deadline: number) => ({ sessionID, deadline, marker: 500, armedAt: 0 })
    await run(h.storage.set(ReviewState.TIMER_PREFIX + "future", timer("future", h.clock.now + 120_000)))
    await run(h.storage.set(ReviewState.TIMER_PREFIX + "overdue", timer("overdue", h.clock.now - 5_000)))
    await run(h.storage.set(ReviewState.TIMER_PREFIX + "elsewhere", timer("elsewhere", h.clock.now + 1)))
    await run(h.storage.set(ReviewState.TIMER_PREFIX + "gone", timer("gone", h.clock.now + 1)))
    await run(h.controller.restore())
    expect(h.scheduled.get("future")?.delayMs).toBe(120_000)
    expect(h.scheduled.get("overdue")?.delayMs).toBe(0)
    expect(h.scheduled.has("elsewhere")).toBe(false)
    expect(h.storage.map.has(ReviewState.TIMER_PREFIX + "elsewhere")).toBe(true)
    expect(h.storage.map.has(ReviewState.TIMER_PREFIX + "gone")).toBe(false)
  })

  test("now opens a fresh review and replaces an open one", async () => {
    const h = harness()
    h.idleSession("s1")
    await run(h.controller.command("s1", "now"))
    await run(h.controller.command("s1", "now"))
    expect(h.published).toHaveLength(2)
    const [first, second] = h.published
    expect(ReviewState.review(h.storage.map.get(ReviewState.REVIEW_PREFIX + first.reviewID))?.status).toBe("superseded")
    expect(h.storage.map.get(ReviewState.OPEN_PREFIX + "s1")).toBe(second.reviewID)
    h.idleSession("busy", 900, { idle: 100 })
    expect(await Effect.runPromise(Effect.flip(h.controller.command("busy", "now")))).toBeInstanceOf(Error)
  })
})

describe("rpc status and run", () => {
  const lan = {
    urls: ["http://127.0.0.1:4096", "http://192.168.1.5:4096"],
    channels: ["OPENCODE_REVIEW_FEISHU_WEBHOOK"],
  }

  test("status reports settings, this session's timer, open links and what is missing", async () => {
    const h = harness({ server: { urls: ["http://127.0.0.1:4096"], channels: [] } })
    await h.enable()
    h.idleSession("s1")
    await run(h.controller.finished("s1"))
    const status = await run(h.controller.snapshot("s1"))
    expect(status).toMatchObject({
      enabled: true,
      durationMs: 600_000,
      addressesKnown: true,
      lan: null,
      public: null,
      channels: [],
      pending: 0,
      timerAt: 1_000_000 + 600_000,
      reviewUntil: null,
    })
    expect(status.hints.map((hint) => hint.level)).toEqual(["warning", "warning"])
    expect(status.hints[0].message).toContain("opencode service set hostname 0.0.0.0")
    expect(status.hints[0].message).toContain("opencode service set remote true")
  })

  test("run turns user errors into ok: false and returns fresh status", async () => {
    const h = harness({ server: lan })
    const on = await run(h.controller.run("s1", "5m"))
    expect(on).toMatchObject({
      ok: true,
      status: { enabled: true, durationMs: 300_000, lan: "http://192.168.1.5:4096" },
    })
    expect(on.status.hints.map((hint) => hint.level)).toEqual(["info"])
    const bad = await run(h.controller.run("s1", "soon"))
    expect(bad.ok).toBe(false)
    expect(bad.message).toContain("Usage: /review-remote")
  })

  test("now refuses a loopback-only server and says what to run, without opening a review", async () => {
    const h = harness({ server: { urls: ["http://127.0.0.1:4096"], channels: ["x"] } })
    h.idleSession("s1")
    const result = await run(h.controller.run("s1", "now"))
    expect(result.ok).toBe(false)
    expect(result.message).toContain("opencode service set remote true")
    expect(h.published).toHaveLength(0)
  })

  test("now counts as a pending link; reachability is unknown without a server layer", async () => {
    const h = harness()
    h.idleSession("s1")
    const result = await run(h.controller.run("s1", "now"))
    expect(result.ok).toBe(true)
    expect(result.status).toMatchObject({ addressesKnown: false, pending: 1, hints: [] })
    expect(result.status.reviewUntil).toBe(1_000_000 + ReviewState.DEFAULT_TTL)
  })
})
