import { describe, expect, test } from "bun:test"
import { distance, midpoint, nextZoom } from "../host/touch.js"

describe("pinch math", () => {
  test("scales zoom by the finger-distance ratio and clamps it", () => {
    expect(nextZoom(1, 100, 200)).toBe(2)
    expect(nextZoom(1, 100, 50)).toBe(0.5)
    expect(nextZoom(1, 10, 10_000, 0.00001, 16)).toBe(16)
  })

  test("measures the span and midpoint of two pointers", () => {
    const a = { clientX: 0, clientY: 0 }
    const b = { clientX: 30, clientY: 40 }
    expect(distance(a, b)).toBe(50)
    expect(midpoint(a, b)).toEqual({ clientX: 15, clientY: 20 })
  })
})
