import { describe, expect, test } from "bun:test"
import { ReviewDecide } from "../src/decide.js"
import { ReviewRequest } from "../src/request.js"
import { ReviewResult } from "../src/result.js"
import { ReviewState } from "../src/state.js"
import { ReviewToken } from "../src/token.js"

const stored = (file: string, mime = "image/png"): ReviewRequest.StoredFile => ({
  file,
  mime,
  size: 10,
  sha256: "h",
  source: "/repo/" + file,
})

const items: ReviewRequest.StoredItem[] = [
  {
    id: "shots",
    kind: "image",
    title: "Boss room",
    bundle: "r1",
    feedback: { verdict: true, annotate: true, checks: [{ id: "light", label: "灯光方向" }] },
    assets: [
      { id: "far", label: "远景", stored: stored("far.png") },
      { id: "near", stored: stored("near.png") },
    ],
  },
  {
    id: "attack",
    kind: "video",
    title: "攻击动作",
    bundle: "r1",
    assets: [{ id: "clip", fps: 30, stored: stored("clip.mp4", "video/mp4") }],
  },
  ReviewRequest.diffItem("r1"),
  {
    id: "settings",
    kind: "custom",
    title: "设置页",
    bundle: "r1",
    assets: [],
    custom: { entry: "index.html", files: [] },
  },
]

describe("request", () => {
  test("ids come from file names, reduced to the id alphabet", () => {
    expect(ReviewRequest.idFrom("out/boss room.v2.png")).toBe("boss_room.v2")
    expect(ReviewRequest.idFrom("C:\\shots\\a.png")).toBe("a")
    expect(ReviewRequest.idFrom("..")).toBe("asset")
  })

  test("validate fills ids and catches duplicates, wrong fields and bad waits", () => {
    const ok = ReviewRequest.validate({
      title: "t",
      items: [{ id: "a", kind: "image", title: "A", assets: [{ path: "x/1.png" }, { path: "y/2.png", id: "two" }] }],
      wait: { mode: "block", timeoutMs: 60_000, onTimeout: { plan: "按方案 A 继续", link: "keep" } },
    })
    expect(ok.ok && ok.input.items[0].assets?.map((asset) => asset.id)).toEqual(["1", "two"])
    const bad = ReviewRequest.validate({
      title: "t",
      send: "with_next_idle",
      wait: { mode: "block" },
      items: [
        { id: "a", kind: "image", title: "A", assets: [{ path: "x/1.png" }, { path: "y/1.png", fps: 30 }] },
        { id: "a", kind: "custom", title: "B" },
        { id: "c", kind: "image", title: "C", assets: [{ path: "c.png" }], diff: {} },
      ],
    })
    expect(bad.ok).toBe(false)
    const errors = bad.ok ? [] : bad.errors
    expect(errors).toContain("send with_next_idle cannot block")
    expect(errors.some((error) => error.includes('"1" is used twice'))).toBe(true)
    expect(errors.some((error) => error.includes("fps must be"))).toBe(true)
    expect(errors.some((error) => error.includes('"a" is used twice'))).toBe(true)
    expect(errors.some((error) => error.includes("custom needs custom.entry"))).toBe(true)
    expect(errors.some((error) => error.includes("only diff takes diff"))).toBe(true)
  })

  test("the page states what the agent does while waiting", () => {
    expect(ReviewRequest.describeWait(undefined, 0)).toContain("没有停下来等你")
    expect(ReviewRequest.describeWait({ mode: "block" }, 0)).toContain("正在等你的反馈")
    const timed = ReviewRequest.describeWait(
      { mode: "block", timeoutMs: 30 * 60_000, onTimeout: { plan: "按方案 A 继续", link: "close" } },
      Date.UTC(2026, 0, 1),
    )
    expect(timed).toContain("最多等到")
    expect(timed).toContain("按方案 A 继续")
    expect(timed).toContain("链接会失效")
  })
})

describe("result", () => {
  const raw = {
    decision: "changes",
    text: " 灯光整体偏暗 ",
    items: [
      {
        id: "shots",
        checks: [
          { id: "light", verdict: "fail" },
          { id: "ghost", verdict: "pass" },
        ],
        assets: [
          {
            asset: "far",
            verdict: "fail",
            annotations: [
              { n: 1, shape: "rect", rect: { x1: 812, y1: 344, x2: 990, y2: 420 }, text: "阴影方向反了" },
              { n: 2, shape: "point", rect: { x1: 1520, y1: 212, x2: 1520, y2: 212 }, text: "白点闪烁" },
            ],
            files: ["shots-far.png", "missing.png"],
          },
          { asset: "near", verdict: "pass" },
          { asset: "unknown", verdict: "fail" },
        ],
      },
      {
        id: "attack",
        assets: [
          {
            asset: "clip",
            annotations: [
              {
                n: 1,
                shape: "rect",
                rect: { x1: 480, y1: 260, x2: 620, y2: 400 },
                frame: { timeMs: 3200, index: 96 },
                text: "拖尾断开",
              },
            ],
            files: ["attack-clip-96.png"],
          },
        ],
      },
      {
        id: "diff",
        assets: [
          {
            asset: "src/shadow.ts",
            annotations: [{ n: 1, shape: "line", line: { side: "new", start: 42, end: 48 }, text: "常量提出来" }],
          },
        ],
      },
      { id: "settings", verdict: "pass", custom: { landscape: "ok" } },
      { id: "nope", verdict: "pass" },
    ],
  }

  const checked = ReviewResult.check({
    reviewID: "r1",
    now: Date.UTC(2026, 10, 13),
    raw,
    items: [...items, { ...items[0], id: "untouched" }],
    uploaded: new Set(["shots-far.png", "attack-clip-96.png"]),
    diffFiles: ["src/shadow.ts"],
  })!

  test("keeps only what the request asked about and aggregates verdicts", () => {
    expect(checked.decision).toBe("changes")
    expect(checked.text).toBe("灯光整体偏暗")
    expect(checked.items.map((item) => item.id)).toEqual(["shots", "attack", "diff", "settings"])
    expect(checked.skipped).toEqual(["untouched"])
    const shots = checked.items[0]
    expect(shots.verdict).toBe("fail")
    expect(shots.checks).toEqual([{ id: "light", label: "灯光方向", verdict: "fail" }])
    expect(shots.assets.map((asset) => asset.asset)).toEqual(["far", "near"])
    expect(shots.assets[0].files).toEqual(["shots-far.png"])
    expect(shots.assets[0].label).toBe("远景")
    expect(checked.items[3].custom).toEqual({ landscape: "ok" })
    expect(
      ReviewResult.check({ reviewID: "r1", now: 0, raw: { decision: "maybe" }, items, uploaded: new Set() }),
    ).toBeUndefined()
  })

  test("renders coordinates, frame times and diff lines for the agent", () => {
    const text = ReviewResult.prompt(checked, "/data/review/r1/feedback/feedback.json")
    expect(text).toContain("request these changes")
    expect(text).toContain('1. image "Boss room" [shots] ✗ fail')
    expect(text).toContain('check "灯光方向" ✗ fail')
    expect(text).toContain("- far (远景) ✗ fail")
    expect(text).toContain("① box (812,344)-(990,420): 阴影方向反了")
    expect(text).toContain("② point (1520,212): 白点闪烁")
    expect(text).toContain("① @00:03.200 (frame 96) box (480,260)-(620,400): 拖尾断开")
    expect(text).toContain("① new line 42-48: 常量提出来")
    expect(text).toContain('page result: {"landscape":"ok"}')
    expect(text).toContain("Not reviewed: untouched")
    expect(text).toContain("/data/review/r1/feedback/feedback.json")
    expect(ReviewResult.attachments(checked)).toEqual(["shots-far.png", "attack-clip-96.png"])
  })

  test("file names stay plain image names", () => {
    expect(ReviewResult.fileName("shots-far.png")).toBe(true)
    expect(ReviewResult.fileName("../x.png")).toBe(false)
    expect(ReviewResult.fileName("x.svg")).toBe(false)
    expect(ReviewResult.fileName(".png")).toBe(false)
  })
})

describe("decide by origin", () => {
  const token = ReviewToken.generate()
  const base: ReviewState.Review = {
    id: "r1",
    sessionID: "s1",
    directory: "/repo",
    title: "t",
    summary: "s",
    tokenHash: ReviewToken.hash(token),
    marker: 100,
    createdAt: 0,
    expiresAt: 10_000,
    status: "open",
  }
  const running = { busy: 300, idle: 200 }

  test("idle and now reviews end when the desktop moves on; agent reviews do not", () => {
    expect(ReviewDecide.check({ review: base, token, now: 1, session: running })).toBe("continued")
    expect(ReviewDecide.check({ review: { ...base, origin: "now" }, token, now: 1, session: running })).toBe(
      "continued",
    )
    expect(ReviewDecide.check({ review: { ...base, origin: "agent" }, token, now: 1, session: running })).toBe("ok")
    expect(
      ReviewDecide.check({ review: { ...base, origin: "agent", status: "closed" }, token, now: 1, session: running }),
    ).toBe("expired")
  })
})
