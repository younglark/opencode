export * as ReviewController from "./controller.js"

import { Effect, Schema } from "effect"
import type { ReviewBridge } from "./bridge.js"
import { ReviewCommand } from "./command.js"
import { ReviewDuration } from "./duration.js"
import type { ReviewRpc } from "./rpc.js"
import { ReviewState } from "./state.js"
import { ReviewStatus } from "./status.js"
import { ReviewToken } from "./token.js"

export interface SessionView {
  readonly id: string
  readonly parentID?: string
  readonly title?: string
  readonly directory: string
  readonly busy?: number
  readonly idle?: number
}

export interface Storage {
  readonly get: (key: string) => Effect.Effect<Schema.Json | undefined>
  readonly set: (key: string, value: Schema.Json) => Effect.Effect<void>
  readonly remove: (key: string) => Effect.Effect<void>
  readonly scan: (options: {
    readonly prefix: string
    readonly after?: string
    readonly limit?: number
  }) => Effect.Effect<{
    readonly entries: ReadonlyArray<{ readonly key: string; readonly value: Schema.Json }>
    readonly next?: string
  }>
}

/** Everything the plugin needs from its host, so the logic runs against fakes in tests. */
export interface Deps {
  /** This plugin instance's Location: timers of other Locations are left to their own instance. */
  readonly directory: string
  readonly storage: Storage
  readonly now: Effect.Effect<number>
  readonly session: (sessionID: string) => Effect.Effect<SessionView | undefined>
  readonly summarize: (sessionID: string) => Effect.Effect<string>
  readonly publish: (review: ReviewBridge.Ready) => Effect.Effect<boolean>
  /** Runs `effect` after `delayMs`, replacing any earlier schedule for the session. */
  readonly schedule: (sessionID: string, delayMs: number, effect: Effect.Effect<void>) => Effect.Effect<void>
  readonly cancel: (sessionID: string) => Effect.Effect<void>
  readonly ttlMs?: number
  /** The server layer's URLs and webhooks; undefined when none runs, which leaves reachability unknown. */
  readonly server?: () => ReviewStatus.Server | undefined
}

const json = (value: unknown) => value as Schema.Json

export function make(deps: Deps) {
  const ttl = deps.ttlMs ?? ReviewState.DEFAULT_TTL

  const settings = deps.storage.get(ReviewState.SETTINGS_KEY).pipe(Effect.map(ReviewState.settings))
  const saveSettings = (next: ReviewState.Settings) => deps.storage.set(ReviewState.SETTINGS_KEY, json(next))

  const readTimer = (sessionID: string) =>
    deps.storage.get(ReviewState.TIMER_PREFIX + sessionID).pipe(Effect.map(ReviewState.timer))
  const readReview = (reviewID: string) =>
    deps.storage.get(ReviewState.REVIEW_PREFIX + reviewID).pipe(Effect.map(ReviewState.review))
  const openReview = Effect.fn("ReviewController.openReview")(function* (sessionID: string) {
    const id = yield* deps.storage.get(ReviewState.OPEN_PREFIX + sessionID)
    if (typeof id !== "string") return undefined
    const review = yield* readReview(id)
    return review?.status === "open" ? review : undefined
  })

  const clearTimer = Effect.fn("ReviewController.clearTimer")(function* (sessionID: string) {
    yield* deps.cancel(sessionID)
    yield* deps.storage.remove(ReviewState.TIMER_PREFIX + sessionID)
  })

  /** Marks the session's open review as overtaken by work on the desktop. */
  const supersede = Effect.fn("ReviewController.supersede")(function* (sessionID: string) {
    const review = yield* openReview(sessionID)
    if (!review) return
    yield* deps.storage.set(
      ReviewState.REVIEW_PREFIX + review.id,
      json({ ...review, status: "superseded", closedAt: yield* deps.now }),
    )
    yield* deps.storage.remove(ReviewState.OPEN_PREFIX + sessionID)
  })

  const fallbackSummary = (session: SessionView) => session.title ?? "Session finished"

  /** Creates a review link and hands it to the notifier. `force` replaces an open review of the same execution. */
  const open = Effect.fn("ReviewController.open")(function* (session: SessionView, force: boolean) {
    const marker = ReviewState.marker(session)
    const now = yield* deps.now
    const existing = yield* openReview(session.id)
    if (existing && !force && existing.marker === marker && existing.expiresAt > now) return existing
    if (existing) yield* supersede(session.id)
    const token = ReviewToken.generate()
    const summary = yield* deps.summarize(session.id).pipe(
      Effect.map((text) => (text.trim() === "" ? fallbackSummary(session) : text.trim())),
      Effect.catchCause(() => Effect.succeed(fallbackSummary(session))),
    )
    const review: ReviewState.Review = {
      id: ReviewToken.id(),
      sessionID: session.id,
      directory: session.directory,
      title: session.title ?? session.id,
      summary,
      tokenHash: ReviewToken.hash(token),
      marker,
      createdAt: now,
      expiresAt: now + ttl,
      status: "open",
    }
    // The session may have moved on while the summary was generated.
    const latest = yield* deps.session(session.id)
    if (!latest || ReviewState.running(latest) || ReviewState.marker(latest) !== marker) return undefined
    yield* deps.storage.set(ReviewState.REVIEW_PREFIX + review.id, json(review))
    yield* deps.storage.set(ReviewState.OPEN_PREFIX + session.id, review.id)
    const delivered = yield* deps.publish({
      reviewID: review.id,
      token,
      sessionID: review.sessionID,
      title: review.title,
      summary: review.summary,
      directory: review.directory,
    })
    if (!delivered) yield* Effect.logWarning("review opened but no notifier is registered", { reviewID: review.id })
    return review
  })

  const fire = Effect.fn("ReviewController.fire")(function* (sessionID: string) {
    const timer = yield* readTimer(sessionID)
    yield* deps.storage.remove(ReviewState.TIMER_PREFIX + sessionID)
    if (!timer || !(yield* settings).enabled) return
    const session = yield* deps.session(sessionID)
    if (!session || ReviewState.running(session) || ReviewState.marker(session) !== timer.marker) return
    yield* open(session, false)
  })

  const arm = (timer: ReviewState.Timer, now: number) =>
    deps.schedule(
      timer.sessionID,
      Math.max(0, timer.deadline - now),
      fire(timer.sessionID).pipe(
        Effect.catchCause((cause) => Effect.logWarning("review timer failed", { sessionID: timer.sessionID, cause })),
      ),
    )

  /** An execution of a root session ended: start (or keep) its idle timer. */
  const finished = Effect.fn("ReviewController.finished")(function* (sessionID: string) {
    const current = yield* settings
    if (!current.enabled) return
    const session = yield* deps.session(sessionID)
    if (!session || session.parentID !== undefined || ReviewState.running(session)) return
    const marker = ReviewState.marker(session)
    // Dedupe: the same execution end can be reported more than once (several terminal events, a replay).
    const existing = yield* readTimer(sessionID)
    if (existing?.marker === marker) return
    const review = yield* openReview(sessionID)
    if (review?.marker === marker) return
    const now = yield* deps.now
    const timer: ReviewState.Timer = { sessionID, deadline: now + current.durationMs, marker, armedAt: now }
    yield* deps.storage.set(ReviewState.TIMER_PREFIX + sessionID, json(timer))
    yield* arm(timer, now)
  })

  /** Work started again in the session (any execution): a pending timer is moot. */
  const started = (sessionID: string) => clearTimer(sessionID)

  /** A person typed into the session on the desktop. */
  const humanInput = Effect.fn("ReviewController.humanInput")(function* (sessionID: string) {
    yield* clearTimer(sessionID)
    yield* supersede(sessionID)
  })

  const removed = Effect.fn("ReviewController.removed")(function* (sessionID: string) {
    yield* clearTimer(sessionID)
    yield* supersede(sessionID)
  })

  /** Re-arms this Location's timers from their stored deadlines; overdue ones fire right away. */
  const restore = Effect.fn("ReviewController.restore")(function* () {
    const now = yield* deps.now
    let after: string | undefined
    do {
      const page = yield* deps.storage.scan({ prefix: ReviewState.TIMER_PREFIX, after, limit: 100 })
      for (const entry of page.entries) {
        const timer = ReviewState.timer(entry.value)
        if (!timer) {
          yield* deps.storage.remove(entry.key)
          continue
        }
        const session = yield* deps.session(timer.sessionID)
        if (!session) {
          yield* deps.storage.remove(entry.key)
          continue
        }
        if (session.directory !== deps.directory) continue
        yield* arm(timer, now)
      }
      after = page.next
    } while (after !== undefined)
  })

  const server = () => deps.server?.()

  const pending = Effect.fn("ReviewController.pending")(function* (now: number) {
    let count = 0
    let after: string | undefined
    do {
      const page = yield* deps.storage.scan({ prefix: ReviewState.OPEN_PREFIX, after, limit: 100 })
      for (const entry of page.entries) {
        if (typeof entry.value !== "string") continue
        const review = yield* readReview(entry.value)
        if (review?.status === "open" && review.expiresAt > now) count++
      }
      after = page.next
    } while (after !== undefined)
    return count
  })

  /** Everything a client shows about the mode, for one session when given. */
  const snapshot = Effect.fn("ReviewController.snapshot")(function* (sessionID?: string) {
    const current = yield* settings
    const now = yield* deps.now
    const info = server()
    const addresses = ReviewStatus.addresses(info)
    const timer = sessionID ? yield* readTimer(sessionID) : undefined
    const review = sessionID ? yield* openReview(sessionID) : undefined
    const result: ReviewRpc.Status = {
      enabled: current.enabled,
      durationMs: current.durationMs,
      addressesKnown: addresses.known,
      lan: addresses.lan ?? null,
      public: addresses.public ?? null,
      channels: info?.channels ?? [],
      pending: yield* pending(now),
      timerAt: timer?.deadline ?? null,
      reviewUntil: review && review.expiresAt > now ? review.expiresAt : null,
      hints: ReviewStatus.hints(info),
    }
    return result
  })

  const status = Effect.fn("ReviewController.status")(function* (sessionID?: string) {
    const current = yield* snapshot(sessionID)
    const now = yield* deps.now
    return [...ReviewStatus.lines(current, now), ReviewCommand.USAGE].join("\n")
  })

  /** Runs one `/review-remote` invocation. Returns text to show, or fails with a message. */
  const command = Effect.fn("ReviewController.command")(function* (sessionID: string, text: string) {
    const action = ReviewCommand.parse(text)
    const current = yield* settings
    switch (action.type) {
      case "status":
        return yield* status(sessionID)
      case "invalid":
        return yield* Effect.fail(new Error(action.message))
      case "on":
        yield* saveSettings({ ...current, enabled: true })
        return `Remote review on: a review link is sent after ${ReviewDuration.format(current.durationMs)} idle`
      case "set":
        yield* saveSettings({ ...current, enabled: true, durationMs: action.durationMs })
        return `Remote review on: a review link is sent after ${ReviewDuration.format(action.durationMs)} idle`
      case "off": {
        yield* saveSettings({ ...current, enabled: false })
        yield* clearAll
        return "Remote review off"
      }
      case "now": {
        // A loopback-only link is useless on a phone; say what to set up instead of sending one.
        if (!ReviewStatus.reachable(ReviewStatus.addresses(server())))
          return yield* Effect.fail(new Error(ReviewStatus.hints(server())[0]?.message ?? "No reachable address"))
        const session = yield* deps.session(sessionID)
        if (!session) return yield* Effect.fail(new Error("Session not found"))
        yield* clearTimer(sessionID)
        const review = yield* open(session, true)
        if (!review) return yield* Effect.fail(new Error("The session is still working; try again once it is idle"))
        return "Review link sent"
      }
    }
  })

  // Turning the mode off drops this Location's pending timers; other Locations drop theirs as they fire.
  const clearAll = Effect.gen(function* () {
    let after: string | undefined
    do {
      const page = yield* deps.storage.scan({ prefix: ReviewState.TIMER_PREFIX, after, limit: 100 })
      for (const entry of page.entries) {
        const timer = ReviewState.timer(entry.value)
        if (timer) yield* deps.cancel(timer.sessionID)
        yield* deps.storage.remove(entry.key)
      }
      after = page.next
    } while (after !== undefined)
  })

  /** `command` for RPC clients: user errors become `ok: false` instead of failures, with the fresh status. */
  const run = Effect.fn("ReviewController.run")(function* (sessionID: string, text: string) {
    const outcome = yield* command(sessionID, text).pipe(
      Effect.map((message) => ({ ok: true, message })),
      Effect.catch((error: Error) => Effect.succeed({ ok: false, message: error.message })),
    )
    const result: ReviewRpc.Result = { ...outcome, status: yield* snapshot(sessionID) }
    return result
  })

  return {
    settings,
    snapshot,
    run,
    finished,
    started,
    humanInput,
    removed,
    restore,
    fire,
    open,
    status,
    command,
    readReview,
    openReview,
  }
}

export type Controller = ReturnType<typeof make>
