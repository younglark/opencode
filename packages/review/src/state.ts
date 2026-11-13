export * as ReviewState from "./state.js"

import { Option, Schema } from "effect"
import { ReviewDuration } from "./duration.js"

export const PLUGIN_ID = "opencode.review"
/** Global settings, shared by every project: plugin storage is keyed by plugin, not by Location. */
export const SETTINGS_KEY = "settings"
/** `timer:<sessionID>`: an armed idle timer, stored as an absolute deadline so a restart can resume it. */
export const TIMER_PREFIX = "timer:"
/** `review:<reviewID>`: one review link and its outcome. */
export const REVIEW_PREFIX = "review:"
/** `open:<sessionID>`: the session's open review, so new input can supersede it and triggers can dedupe. */
export const OPEN_PREFIX = "open:"
/** Metadata `source` on feedback written back into a session, so the plugin never treats it as human input. */
export const FEEDBACK_SOURCE = "review-remote"
export const DEFAULT_TTL = 2 * 60 * 60_000

export const Settings = Schema.Struct({
  enabled: Schema.Boolean,
  durationMs: Schema.Finite,
  /** Reserved: append an `opencode pair` link to notifications. Off by default; not wired in v1. */
  includePairLink: Schema.optionalKey(Schema.Boolean),
})
export type Settings = typeof Settings.Type
export const DEFAULT_SETTINGS: Settings = { enabled: false, durationMs: ReviewDuration.DEFAULT }

export const Timer = Schema.Struct({
  sessionID: Schema.String,
  /** Epoch millis when the review fires. */
  deadline: Schema.Finite,
  /** The session's `time.busy` (start of the execution that just ended) when the timer was armed. */
  marker: Schema.Finite,
  armedAt: Schema.Finite,
})
export type Timer = typeof Timer.Type

export const Status = Schema.Literals(["open", "submitted", "superseded"])
export type Status = typeof Status.Type

export const Decision = Schema.Literals(["continue", "changes", "stop"])
export type Decision = typeof Decision.Type

export const Review = Schema.Struct({
  id: Schema.String,
  sessionID: Schema.String,
  directory: Schema.String,
  title: Schema.String,
  summary: Schema.String,
  /** sha256 of the one-time token; the token itself only travels in the notification. */
  tokenHash: Schema.String,
  /** The session's `time.busy` when the review started; any later execution means the desktop moved on. */
  marker: Schema.Finite,
  createdAt: Schema.Finite,
  expiresAt: Schema.Finite,
  status: Status,
  decision: Schema.optionalKey(Decision),
  feedback: Schema.optionalKey(Schema.String),
  closedAt: Schema.optionalKey(Schema.Finite),
})
export type Review = typeof Review.Type

const decodeSettings = Schema.decodeUnknownOption(Settings)
const decodeTimer = Schema.decodeUnknownOption(Timer)
const decodeReview = Schema.decodeUnknownOption(Review)

export function settings(value: unknown): Settings {
  const decoded = Option.getOrUndefined(decodeSettings(value))
  if (!decoded) return DEFAULT_SETTINGS
  return { ...decoded, durationMs: Math.max(ReviewDuration.MIN, decoded.durationMs) }
}
export const timer = (value: unknown) => Option.getOrUndefined(decodeTimer(value))
export const review = (value: unknown) => Option.getOrUndefined(decodeReview(value))

/** The session progressed when it started another execution, or one is running right now. */
export function marker(session: { readonly busy?: number; readonly idle?: number }) {
  return session.busy ?? 0
}
export function running(session: { readonly busy?: number; readonly idle?: number }) {
  return session.busy !== undefined && (session.idle === undefined || session.busy > session.idle)
}
