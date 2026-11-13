import { describe, expect, test } from "bun:test"
import { estimateFps, frameIndex, frameTime, stepTime } from "../host/video.js"

describe("frame math", () => {
  test("uses the centre of each frame and steps by one frame", () => {
    expect(frameTime(96, 30)).toBeCloseTo((96 + 0.5) / 30, 10)
    expect(frameIndex((96 + 0.5) / 30, 30)).toBe(96)
    expect(stepTime((96 + 0.5) / 30, 30, 1, 10)).toBeCloseTo((97 + 0.5) / 30, 10)
    expect(stepTime(0, 30, -1, 10)).toBeCloseTo(0.5 / 30, 10)
  })

  test("clamps a step to the last frame and falls back to 30 fps", () => {
    const last = stepTime(10, 24, 1000, 10)
    expect(last).toBeCloseTo(10 - 1 / 24, 6)
    expect(estimateFps([24.1, 23.9, 24, 24.2, 23.8])).toBeCloseTo(24, 0)
    expect(estimateFps([12])).toBe(30)
  })
})
