import { describe, expect, test } from "bun:test"
import { ReviewCommand } from "../src/command.js"
import { ReviewDuration } from "../src/duration.js"

describe("duration", () => {
  test("parses units and bare minutes", () => {
    expect(ReviewDuration.parse("30s")).toEqual({ ok: false, message: "Duration must be at least 1m" })
    expect(ReviewDuration.parse("90s")).toEqual({ ok: true, ms: 90_000 })
    expect(ReviewDuration.parse("15m")).toEqual({ ok: true, ms: 15 * 60_000 })
    expect(ReviewDuration.parse("2h")).toEqual({ ok: true, ms: 2 * 3_600_000 })
    expect(ReviewDuration.parse("1h30m")).toEqual({ ok: true, ms: 90 * 60_000 })
    expect(ReviewDuration.parse("10")).toEqual({ ok: true, ms: 10 * 60_000 })
    expect(ReviewDuration.parse(" 5 MIN ")).toEqual({ ok: true, ms: 5 * 60_000 })
  })

  test("rejects garbage, zero and out-of-range values", () => {
    for (const input of ["", "abc", "10x", "m", "0", "-5", "15m abc", "25h"])
      expect(ReviewDuration.parse(input).ok).toBe(false)
  })

  test("formats compactly", () => {
    expect(ReviewDuration.format(10 * 60_000)).toBe("10m")
    expect(ReviewDuration.format(90 * 60_000)).toBe("1h30m")
    expect(ReviewDuration.format(45_000)).toBe("45s")
  })
})

describe("command", () => {
  test("maps arguments to actions", () => {
    expect(ReviewCommand.parse("")).toEqual({ type: "status" })
    expect(ReviewCommand.parse("status")).toEqual({ type: "status" })
    expect(ReviewCommand.parse("ON")).toEqual({ type: "on" })
    expect(ReviewCommand.parse("off")).toEqual({ type: "off" })
    expect(ReviewCommand.parse("now")).toEqual({ type: "now" })
    expect(ReviewCommand.parse("15m")).toEqual({ type: "set", durationMs: 15 * 60_000 })
    expect(ReviewCommand.parse("bogus").type).toBe("invalid")
  })
})
