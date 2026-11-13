export * as ReviewCommand from "./command.js"

import { ReviewDuration } from "./duration.js"

export const NAME = "review-remote"
export const USAGE = "Usage: /review-remote <duration, e.g. 30s | 15m | 2h> | on | off | now | status"

export type Action =
  | { readonly type: "status" }
  | { readonly type: "on" }
  | { readonly type: "off" }
  | { readonly type: "now" }
  | { readonly type: "set"; readonly durationMs: number }
  | { readonly type: "invalid"; readonly message: string }

export function parse(input: string): Action {
  const text = input.trim().toLowerCase()
  if (text === "" || text === "status") return { type: "status" }
  if (text === "on") return { type: "on" }
  if (text === "off") return { type: "off" }
  if (text === "now") return { type: "now" }
  const duration = ReviewDuration.parse(text)
  if (!duration.ok) return { type: "invalid", message: `${duration.message}\n${USAGE}` }
  return { type: "set", durationMs: duration.ms }
}
