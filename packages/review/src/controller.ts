export * as ReviewController from "./controller.js"

import { Effect, Schema } from "effect"
import type { ReviewBridge } from "./bridge.js"
import { ReviewCommand } from "./command.js"
import { ReviewDuration } from "./duration.js"
import { ReviewState } from "./state.js"
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
  }) => Effect.Effect<{ readonly entries: ReadonlyArray<{ readonly key: string; readonly value: Schema.Json }>; readonly next?: string }>
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

  const status = Effect.fn("ReviewController.status")(function* (sessionID?: string) {
    const current = yield* settings
    const lines = [
      `Remote review: ${current.enabled ? "on" : "off"}, idle ${ReviewDuration.format(current.durationMs)}`,
    ]
    if (sessionID) {
      const now = yield* deps.now
      const timer = yield* readTimer(sessionID)
      if (timer) lines.push(`This session: review link in ${ReviewDuration.format(Math.max(0, timer.deadline - now))}`)
      const review = yield* openReview(sessionID)
      if (review) lines.push(`This session: review link open until ${new Date(review.expiresAt).toISOString()}`)
    }
    lines.push(ReviewCommand.USAGE)
    return lines.join("\n")
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

  return { settings, finished, started, humanInput, removed, restore, fire, open, status, command, readReview, openReview }
}

export type Controller = ReturnType<typeof make>
