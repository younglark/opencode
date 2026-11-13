import { describe, expect, test } from "bun:test"
import { ReviewShell } from "../src/shell.js"

const shots: ReviewShell.ItemInfo = {
  id: "shots",
  kind: "image",
  title: "Renders",
  feedback: { verdict: true, required: true, checks: [{ id: "shadow", label: "阴影正确" }] },
  assetIDs: ["far", "near"],
}
const clip: ReviewShell.ItemInfo = {
  id: "clip",
  kind: "video",
  title: "Clip",
  feedback: { verdict: true },
  assetIDs: ["c"],
}
const notes: ReviewShell.ItemInfo = {
  id: "notes",
  kind: "custom",
  title: "设置页",
  feedback: { checks: [{ id: "wide", label: "横屏不遮挡" }] },
  assetIDs: [],
}

const items = [shots, clip, notes]

describe("draft", () => {
  test("ignores missing, garbled or version-mismatched storage", () => {
    expect(ReviewShell.parse(undefined)).toEqual(ReviewShell.empty())
    expect(ReviewShell.parse("{")).toEqual(ReviewShell.empty())
    expect(ReviewShell.parse(JSON.stringify({ v: 2, decision: "changes" }))).toEqual(ReviewShell.empty())
    expect(ReviewShell.parse(JSON.stringify({ v: 1, decision: "maybe" }))).toEqual(ReviewShell.empty())
  })

  test("round-trips a valid draft", () => {
    const draft: ReviewShell.Draft = {
      v: 1,
      decision: "changes",
      text: "整体偏暗",
      item: "shots",
      asset: { shots: "near" },
      seen: { shots: true },
      items: { shots: { assets: { far: { verdict: "fail", text: "阴影反了" } } } },
    }
    expect(ReviewShell.parse(JSON.stringify(draft))).toEqual(draft)
    expect(ReviewShell.key("r1")).toBe("opencode.review.draft.r1")
  })
})

describe("status and required items", () => {
  test("is unread until opened, open once seen, and follows asset verdicts", () => {
    const draft = ReviewShell.empty()
    expect(ReviewShell.status(shots, draft)).toBe("unread")
    expect(ReviewShell.itemVerdict(shots, draft)).toBeUndefined()
    draft.seen = { shots: true }
    expect(ReviewShell.status(shots, draft)).toBe("open")
    draft.items = { shots: { assets: { far: { verdict: "pass" }, near: { verdict: "pass" } } } }
    expect(ReviewShell.itemVerdict(shots, draft)).toBe("pass")
    expect(ReviewShell.status(shots, draft)).toBe("pass")
    draft.items.shots.assets!.far = { verdict: "fail" }
    expect(ReviewShell.itemVerdict(shots, draft)).toBe("fail")
    expect(ReviewShell.status(shots, draft)).toBe("fail")
  })

  test("an explicit item verdict wins over its assets", () => {
    const draft: ReviewShell.Draft = {
      v: 1,
      decision: "continue",
      items: { shots: { verdict: "pass", assets: { far: { verdict: "fail" } } } },
    }
    expect(ReviewShell.itemVerdict(shots, draft)).toBe("pass")
  })

  test("required items need a full verdict; optional ones count as done once seen", () => {
    const draft = ReviewShell.empty()
    expect(ReviewShell.missing(items, draft).map((item) => item.id)).toEqual(["shots"])
    expect(ReviewShell.completed(items, draft)).toBe(0)
    draft.seen = { notes: true }
    expect(ReviewShell.completed(items, draft)).toBe(1)
    draft.items = { shots: { assets: { far: { verdict: "pass" } } } }
    expect(ReviewShell.missing(items, draft)).toHaveLength(1)
    draft.items.shots.assets!.near = { verdict: "pass" }
    expect(ReviewShell.missing(items, draft)).toEqual([])
    draft.items.clip = { assets: { c: { verdict: "fail" } } }
    expect(ReviewShell.completed(items, draft)).toBe(3)
  })
})

describe("submission", () => {
  test("drops empty entries and keeps checks, texts and per-asset verdicts", () => {
    const draft: ReviewShell.Draft = {
      v: 1,
      decision: "changes",
      text: "  整体再亮一点  ",
      items: {
        shots: {
          text: "远景不行",
          checks: { shadow: "fail" },
          assets: {
            far: { verdict: "fail", text: " 阴影反了 " },
            near: { verdict: "pass" },
          },
        },
        clip: { assets: { c: {} } },
        notes: { checks: { wide: "pass" }, text: "  " },
      },
    }
    expect(ReviewShell.toSubmission(items, draft)).toEqual({
      decision: "changes",
      text: "整体再亮一点",
      items: [
        {
          id: "shots",
          text: "远景不行",
          checks: [{ id: "shadow", verdict: "fail" }],
          assets: [
            { asset: "far", verdict: "fail", text: "阴影反了" },
            { asset: "near", verdict: "pass" },
          ],
        },
        { id: "notes", checks: [{ id: "wide", verdict: "pass" }] },
      ],
    })
  })


  test("keeps annotation marks and raw overlay data in the submission and treats them as input", () => {
    const marks = [{ n: 1, shape: "rect" as const, rect: { x1: 10, y1: 20, x2: 80, y2: 90 }, text: "阴影反了" }]
    const raw = { schemaVersion: "feedback-minimal-4", objects: [] }
    const draft: ReviewShell.Draft = {
      v: 1,
      decision: "changes",
      items: {
        shots: { assets: { far: { annotations: marks, raw } } },
      },
    }
    expect(ReviewShell.status(shots, draft)).toBe("open")
    expect(ReviewShell.toSubmission(items, draft)).toEqual({
      decision: "changes",
      items: [{ id: "shots", assets: [{ asset: "far", annotations: marks, raw }] }],
    })
  })


  test("keeps video frame annotations and raw overlay data in the submission", () => {
    const marks = [
      {
        n: 1,
        shape: "rect" as const,
        rect: { x1: 10, y1: 20, x2: 80, y2: 90 },
        text: "拖尾断开",
        frame: { timeMs: 3200, timeUs: 3_200_000, index: 96 },
      },
    ]
    const raw = { schemaVersion: "video-feedback-1", frames: [], fps: 30 }
    const draft: ReviewShell.Draft = {
      v: 1,
      decision: "changes",
      items: { clip: { assets: { c: { annotations: marks, raw, files: ["clip-c-f96.annotated.png"] } } } },
    }
    expect(ReviewShell.status(clip, draft)).toBe("open")
    expect(ReviewShell.toSubmission(items, draft)).toEqual({
      decision: "changes",
      items: [
        {
          id: "clip",
          assets: [{ asset: "c", annotations: marks, raw, files: ["clip-c-f96.annotated.png"] }],
        },
      ],
    })
  })

  test("suggests changes when anything failed, continue when every judged item passed, and keeps stop", () => {
    const draft: ReviewShell.Draft = { v: 1, decision: "continue", items: { shots: { verdict: "fail" } } }
    expect(ReviewShell.suggest(items, draft)).toBe("changes")
    draft.items = {
      shots: { assets: { far: { verdict: "pass" }, near: { verdict: "pass" } } },
      clip: { assets: { c: { verdict: "pass" } } },
    }
    expect(ReviewShell.suggest(items, draft)).toBe("continue")
    draft.decision = "stop"
    expect(ReviewShell.suggest(items, draft)).toBe("stop")
  })
})
