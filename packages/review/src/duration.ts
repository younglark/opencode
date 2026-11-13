export * as ReviewDuration from "./duration.js"

export const MINUTE = 60_000
export const DEFAULT = 10 * MINUTE
export const MIN = MINUTE
export const MAX = 24 * 60 * MINUTE

const UNITS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  m: MINUTE,
  min: MINUTE,
  h: 60 * MINUTE,
  hr: 60 * MINUTE,
}

export type Parsed = { readonly ok: true; readonly ms: number } | { readonly ok: false; readonly message: string }

/** `30s`, `15m`, `2h`, `1h30m`; a bare number is minutes. Bounded to [MIN, MAX]. */
export function parse(input: string): Parsed {
  const text = input.trim().toLowerCase()
  if (text === "") return { ok: false, message: "Missing duration" }
  if (/^\d+(\.\d+)?$/.test(text)) return bound(Number(text) * MINUTE, input)
  const pattern = /(\d+(?:\.\d+)?)\s*(sec|min|hr|s|m|h)/g
  let total = 0
  let consumed = ""
  for (const match of text.matchAll(pattern)) {
    total += Number(match[1]) * UNITS[match[2]]
    consumed += match[0]
  }
  if (consumed.replace(/\s+/g, "") !== text.replace(/\s+/g, ""))
    return { ok: false, message: `Invalid duration: ${input}` }
  return bound(total, input)
}

function bound(ms: number, input: string): Parsed {
  if (!Number.isFinite(ms) || ms <= 0) return { ok: false, message: `Invalid duration: ${input}` }
  const rounded = Math.round(ms)
  if (rounded < MIN) return { ok: false, message: `Duration must be at least ${format(MIN)}` }
  if (rounded > MAX) return { ok: false, message: `Duration must be at most ${format(MAX)}` }
  return { ok: true, ms: rounded }
}

export function format(ms: number) {
  const seconds = Math.round(ms / 1_000)
  const h = Math.floor(seconds / 3_600)
  const m = Math.floor((seconds % 3_600) / 60)
  const s = seconds % 60
  const parts = [h ? `${h}h` : "", m ? `${m}m` : "", s ? `${s}s` : ""].filter(Boolean)
  return parts.length === 0 ? "0s" : parts.join("")
}
