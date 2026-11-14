import { describe, expect, test } from "bun:test"
import { ReviewCustom } from "../src/custom.js"

describe("inject", () => {
  test("inserts the bridge once, before the closing body tag", () => {
    const html = ReviewCustom.inject("<!doctype html><html><body><h1>设置</h1></body></html>")
    expect(html).toContain(`<script id="${ReviewCustom.MARKER}">`)
    expect(html).toContain("window.opencodeReview")
    expect(html).toContain("opencode-review:")
    expect(html).toContain("P+'hello'")
    expect(html).toContain("__grokbotXPreview")
    expect(html.indexOf("设置")).toBeLessThan(html.indexOf(`id="${ReviewCustom.MARKER}"`))
    expect(html.indexOf(`id="${ReviewCustom.MARKER}"`)).toBeLessThan(html.toLowerCase().lastIndexOf("</body>"))
    expect(ReviewCustom.inject(html)).toBe(html)
  })

  test("falls back to </html> or the end of a fragment", () => {
    expect(ReviewCustom.inject("<html><p>x</p></html>")).toContain("</script></html>")
    const fragment = ReviewCustom.inject("<p>x</p>")
    expect(fragment.startsWith("<p>x</p><script id=")).toBe(true)
  })
})

describe("protocol", () => {
  test("accepts versioned incoming messages and rejects anything else", () => {
    expect(ReviewCustom.parse({ type: "opencode-review:ready", v: 1 })).toEqual({ type: "ready" })
    expect(ReviewCustom.parse({ type: "opencode-review:result", v: 1, result: { volume: 0.8 } })).toEqual({
      type: "result",
      result: { volume: 0.8 },
    })
    expect(ReviewCustom.parse({ type: "opencode-review:verdict", v: 1, verdict: "fail" })).toEqual({
      type: "verdict",
      verdict: "fail",
    })
    expect(ReviewCustom.parse({ type: "opencode-review:text", v: 1, text: "太暗" })).toEqual({ type: "text", text: "太暗" })
    expect(ReviewCustom.parse({ type: "opencode-review:shortcut", v: 1, key: "Enter", ctrl: true })).toEqual({
      type: "shortcut",
      key: "Enter",
      ctrl: true,
    })
    expect(ReviewCustom.parse({ type: "opencode-review:verdict", v: 1, verdict: "maybe" })).toBeUndefined()
    expect(ReviewCustom.parse({ type: "opencode-review:ready", v: 2 })).toBeUndefined()
    expect(ReviewCustom.parse({ type: "review-annotator:ready", v: 1 })).toBeUndefined()
  })

  test("clips a structured payload and drops one that would overflow the draft", () => {
    expect(ReviewCustom.clip({ volume: 0.8, preset: "night" })).toEqual({ volume: 0.8, preset: "night" })
    expect(ReviewCustom.clip(undefined)).toBeUndefined()
    expect(ReviewCustom.clip({ x: "n".repeat(ReviewCustom.MAX_JSON) })).toBeUndefined()
    expect(ReviewCustom.isHtml("text/html; charset=utf-8")).toBe(true)
    expect(ReviewCustom.isHtml("application/json")).toBe(false)
  })
})
