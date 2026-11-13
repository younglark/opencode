import { describe, expect, test } from "bun:test"
import type { ReviewRpc } from "../src/rpc.js"
import { ReviewStatus } from "../src/status.js"

describe("addresses", () => {
  test("unknown without a server layer", () => {
    expect(ReviewStatus.addresses(undefined)).toEqual({ known: false })
    expect(ReviewStatus.reachable({ known: false })).toBe(true)
  })

  test("loopback is neither LAN nor public; https is the OpenTunnel route", () => {
    const urls = ["http://127.0.0.1:4096/", "http://localhost:4096", "http://[::1]:4096"]
    expect(ReviewStatus.addresses({ urls, channels: [] })).toEqual({ known: true })
    expect(
      ReviewStatus.addresses({ urls: [...urls, "http://10.0.0.2:4096", "https://abc.example.dev/"], channels: [] }),
    ).toEqual({ known: true, lan: "http://10.0.0.2:4096", public: "https://abc.example.dev" })
  })
})

describe("hints", () => {
  test("none when a public link and a webhook exist", () => {
    expect(ReviewStatus.hints({ urls: ["https://x.example"], channels: ["OPENCODE_REVIEW_WECOM_WEBHOOK"] })).toEqual([])
  })

  test("suggests the exact service commands and webhook env vars", () => {
    const hints = ReviewStatus.hints({ urls: ["http://127.0.0.1:1"], channels: [] })
    expect(hints).toHaveLength(2)
    expect(hints[0].message).toContain(ReviewStatus.LAN_COMMAND)
    expect(hints[0].message).toContain(ReviewStatus.REMOTE_COMMAND)
    expect(hints[1].message).toContain("opencode service set env OPENCODE_REVIEW_FEISHU_WEBHOOK <webhook-url>")
    expect(hints[1].message).toContain("opencode service set env OPENCODE_REVIEW_PUSHPLUS_TOKEN <pushplus-token>")
    expect(hints[1].message).toContain("opencode service set env OPENCODE_REVIEW_SERVERCHAN_KEY <sendkey>")
  })

  test("channels only counts non-empty webhook variables", () => {
    expect(
      ReviewStatus.channels({ OPENCODE_REVIEW_FEISHU_WEBHOOK: "https://hook", OPENCODE_REVIEW_WECOM_WEBHOOK: " " }),
    ).toEqual(["OPENCODE_REVIEW_FEISHU_WEBHOOK"])
    expect(
      ReviewStatus.channels({ OPENCODE_REVIEW_PUSHPLUS_TOKEN: "tok", OPENCODE_REVIEW_SERVERCHAN_KEY: "SCTkey" }),
    ).toEqual(["OPENCODE_REVIEW_PUSHPLUS_TOKEN", "OPENCODE_REVIEW_SERVERCHAN_KEY"])
  })

  test("a WeChat channel alone satisfies the notification hint", () => {
    expect(ReviewStatus.hints({ urls: ["https://x.example"], channels: ["OPENCODE_REVIEW_PUSHPLUS_TOKEN"] })).toEqual(
      [],
    )
  })
})

describe("lines", () => {
  const base: ReviewRpc.Status = {
    enabled: true,
    durationMs: 600_000,
    addressesKnown: true,
    lan: "http://10.0.0.2:4096",
    public: null,
    channels: ["x"],
    pending: 0,
    timerAt: null,
    reviewUntil: null,
    hints: [],
  }

  test("headline names the mode, idle time and link kind", () => {
    expect(ReviewStatus.headline(base)).toBe("Remote review on · idle 10m · LAN link")
    expect(ReviewStatus.headline({ ...base, enabled: false, public: "https://x" })).toBe(
      "Remote review off · idle 10m · public link",
    )
    expect(ReviewStatus.headline({ ...base, addressesKnown: false, lan: null })).toBe("Remote review on · idle 10m")
  })

  test("adds the session timer, open links and hints", () => {
    const lines = ReviewStatus.lines(
      { ...base, timerAt: 1_000 + 120_000, pending: 2, hints: [{ level: "info", message: "do this" }] },
      1_000,
    )
    expect(lines[1]).toStartWith("This session: link in 2m (")
    expect(lines.slice(2)).toEqual(["Open review links: 2", "do this"])
  })
})
